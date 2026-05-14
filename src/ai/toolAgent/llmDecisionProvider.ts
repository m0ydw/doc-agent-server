import { FinishResultSchema, ToolDecisionSchema, type ToolDecision } from "./schemas";
import type { DocxToolAgentState } from "./state";
import type { ToolDefinition } from "./toolTypes";
import { buildToolDecisionPrompt } from "./llmDecisionPrompt";

export interface LlmDecisionClient {
  complete(prompt: string): Promise<string>;
}

export interface LlmDecisionProviderOptions {
  client: LlmDecisionClient;
  availableTools: ToolDefinition[];
  maxRetries?: number;
  policy?: "planning_only";
}

export interface ParsedToolDecisionJson {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface DecisionValidationResult {
  ok: boolean;
  decision?: ToolDecision;
  error?: string;
}

interface PlanningPolicyResult {
  allowed: boolean;
  reason?: string;
}

const CONTROL_TOOL_NAMES = new Set(["ask_user", "finish"]);
const WRITE_TOOL_NAME = "write_docx";

export function createLlmDecisionProvider(options: LlmDecisionProviderOptions) {
  const maxRetries = options.maxRetries ?? 1;

  return async (state: DocxToolAgentState): Promise<ToolDecision> => {
    const feedback: string[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const prompt = buildToolDecisionPrompt({
        state,
        availableTools: options.availableTools,
        policy: options.policy,
        feedback,
      });
      const rawOutput = await options.client.complete(prompt);
      const parsedJson = parseToolDecisionJson(rawOutput);
      if (!parsedJson.ok) {
        feedback.push(`JSON_PARSE_FAILED: ${parsedJson.error}`);
        continue;
      }

      const parsedDecision = ToolDecisionSchema.safeParse(parsedJson.value);
      if (!parsedDecision.success) {
        feedback.push(`TOOL_DECISION_SCHEMA_FAILED: ${parsedDecision.error.message}`);
        continue;
      }

      const toolValidation = validateToolDecisionAgainstTools(
        parsedDecision.data,
        options.availableTools
      );
      if (!toolValidation.ok) {
        feedback.push(`TOOL_VALIDATION_FAILED: ${toolValidation.error}`);
        continue;
      }

      if (options.policy === "planning_only") {
        const policyValidation = enforcePlanningOnlyPolicy(parsedDecision.data, state);
        if (!policyValidation.allowed) {
          feedback.push(`PLANNING_ONLY_POLICY_FAILED: ${policyValidation.reason}`);
          continue;
        }
      }

      return parsedDecision.data;
    }

    return createFallbackDecision(state, feedback);
  };
}

export function parseToolDecisionJson(text: string): ParsedToolDecisionJson {
  const trimmed = text.trim();
  const unfenced = stripJsonFence(trimmed);

  try {
    return { ok: true, value: JSON.parse(unfenced) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateToolDecisionAgainstTools(
  decision: ToolDecision,
  tools: ToolDefinition[]
): DecisionValidationResult {
  if (decision.toolName === WRITE_TOOL_NAME) {
    return { ok: false, error: "write_docx is hidden from the LLM decision provider." };
  }

  if (CONTROL_TOOL_NAMES.has(decision.toolName)) {
    if (decision.toolName === "finish") {
      const finishResult = FinishResultSchema.safeParse(decision.args);
      if (!finishResult.success) {
        return { ok: false, error: `finish args invalid: ${finishResult.error.message}` };
      }
    }
    return { ok: true, decision };
  }

  const tool = tools.find(candidate => candidate.name === decision.toolName);
  if (!tool) {
    return { ok: false, error: `Tool is not available: ${decision.toolName}` };
  }

  const argsResult = tool.argsSchema.safeParse(decision.args);
  if (!argsResult.success) {
    return { ok: false, error: `Args schema failed for ${decision.toolName}: ${argsResult.error.message}` };
  }

  return { ok: true, decision };
}

export function enforcePlanningOnlyPolicy(
  decision: ToolDecision,
  state: DocxToolAgentState
): PlanningPolicyResult {
  if (decision.toolName === WRITE_TOOL_NAME) {
    return { allowed: false, reason: "write_docx is forbidden in planning_only policy." };
  }

  if (state.stepCount >= state.maxSteps) {
    return allowOnlyTerminalFailure(decision, "maxSteps has already been reached.");
  }

  const repeatedFailure = findRepeatedFailedTool(state);
  if (repeatedFailure && decision.toolName === repeatedFailure) {
    return { allowed: false, reason: `Refusing to repeat failed tool: ${repeatedFailure}` };
  }

  if (!state.referenceDocId || !state.targetDocId) {
    return allowAskUserOrTerminalBlocked(
      decision,
      "Missing referenceDocId or targetDocId."
    );
  }

  if (!state.executionPlan) {
    return allowToolNames(decision, [
      "inspect_documents",
      "inspect_table_structure",
      "inspect_sdk_cell_text",
      "extract_reference_templates",
      "generate_fill_plan",
      "ask_user",
      "finish",
    ], "No executionPlan exists yet.", finishMustNotBeSuccess);
  }

  if (!state.dryRun) {
    return allowToolNames(decision, [
      "dry_run_fill_plan",
      "ask_user",
      "finish",
    ], "executionPlan exists but dryRun has not run.", finishMustNotBeSuccess);
  }

  const dryRunStatus = getStatus(state.dryRun);
  if (dryRunStatus === "blocked" || dryRunStatus === "failed") {
    return allowAskUserOrTerminalBlocked(
      decision,
      `dry_run_fill_plan status is ${dryRunStatus}.`
    );
  }

  if (!state.verification) {
    return allowToolNames(decision, [
      "verify_docx",
      "ask_user",
      "finish",
    ], "dryRun exists but verification has not run.", finishMustNotBeSuccess);
  }

  return allowToolNames(decision, [
    "finish",
    "ask_user",
  ], "verification exists; the provider should finish or ask for clarification.");
}

export function createMockLlmDecisionClient(responses: string[]): LlmDecisionClient & {
  prompts: string[];
  callCount: number;
} {
  const prompts: string[] = [];
  return {
    prompts,
    get callCount() {
      return prompts.length;
    },
    async complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      const response = responses.shift();
      return response ?? responses[responses.length - 1] ?? "not json";
    },
  };
}

function stripJsonFence(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length >= 3 && lines[0].trim() === "```json" && lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  if (lines.length >= 3 && lines[0].trim() === "```" && lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  return text;
}

function allowToolNames(
  decision: ToolDecision,
  allowedToolNames: string[],
  reason: string,
  finishValidator?: (decision: ToolDecision) => PlanningPolicyResult
): PlanningPolicyResult {
  if (!allowedToolNames.includes(decision.toolName)) {
    return { allowed: false, reason: `${reason} Allowed next tools: ${allowedToolNames.join(", ")}` };
  }
  if (decision.toolName === "finish" && finishValidator) {
    return finishValidator(decision);
  }
  return { allowed: true };
}

function allowAskUserOrTerminalBlocked(
  decision: ToolDecision,
  reason: string
): PlanningPolicyResult {
  if (decision.toolName === "ask_user") {
    return { allowed: true };
  }
  if (decision.toolName === "finish") {
    const status = getFinishStatus(decision);
    if (status === "blocked" || status === "failed" || status === "needs_user_input") {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `${reason} Choose ask_user or finish with blocked/failed/needs_user_input.` };
}

function allowOnlyTerminalFailure(
  decision: ToolDecision,
  reason: string
): PlanningPolicyResult {
  if (decision.toolName === "finish") {
    const status = getFinishStatus(decision);
    if (status === "failed" || status === "blocked") {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `${reason} Choose finish with failed or blocked status.` };
}

function finishMustNotBeSuccess(decision: ToolDecision): PlanningPolicyResult {
  const status = getFinishStatus(decision);
  if (status === "success") {
    return { allowed: false, reason: "finish success is not allowed before dry_run_fill_plan and verify_docx complete." };
  }
  return { allowed: true };
}

function getFinishStatus(decision: ToolDecision): string | undefined {
  if (decision.toolName !== "finish") {
    return undefined;
  }
  const parsed = FinishResultSchema.safeParse(decision.args);
  return parsed.success ? parsed.data.status : undefined;
}

function getStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.status === "string" ? record.status : undefined;
}

function findRepeatedFailedTool(state: DocxToolAgentState): string | undefined {
  const recent = state.toolHistory.slice(-2);
  if (recent.length < 2) {
    return undefined;
  }
  const [first, second] = recent;
  if (first.toolName === second.toolName && first.error && second.error) {
    return first.toolName;
  }
  return undefined;
}

function createFallbackDecision(
  state: DocxToolAgentState,
  feedback: string[]
): ToolDecision {
  const summary = feedback.length
    ? `LLM decision validation failed: ${feedback[feedback.length - 1]}`
    : "LLM decision validation failed.";

  if (!state.referenceDocId || !state.targetDocId) {
    return {
      summary: "Need reference and target documents before planning.",
      observations: feedback,
      reason: "referenceDocId or targetDocId is missing.",
      toolName: "ask_user",
      args: {
        message: "请提供 referenceDocId 和 targetDocId 后再继续生成 DOCX 填充计划。",
      },
    };
  }

  return {
    summary,
    observations: feedback,
    reason: "The model did not produce a valid safe planning-only decision after retries.",
    toolName: "finish",
    args: {
      status: "failed",
      summary,
      details: { feedback },
    },
  };
}
