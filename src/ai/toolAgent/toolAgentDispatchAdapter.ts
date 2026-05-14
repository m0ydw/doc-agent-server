import type { ToolAgentEvent } from "./events";
import { createLangChainDecisionClient, type LangChainLikeLlm } from "./llmDecisionClientAdapter";
import { createLlmDecisionProvider, type LlmDecisionClient } from "./llmDecisionProvider";
import type { ToolAgentProviderMode } from "./toolAgentProviderModes";
import type { FinishResult, ToolDecision } from "./schemas";
import type { DocxToolAgentState } from "./state";
import { runToolAgentLoop, type ToolAgentLoopResult, type ToolDecisionProvider } from "./toolAgentLoop";
import { mapToolAgentEventToWsMessages, type ToolAgentWsMessage } from "./toolAgentEventAdapter";
import { clearToolsForTest, registerTool } from "./toolRegistry";
import { createSafeToolSet } from "./toolSets";
import type { ToolDefinition } from "./toolTypes";

export interface ToolAgentDispatchInput {
  userInput: string;
  docId?: string;
  referenceDocId?: string;
  targetDocId?: string;
  mode?: string;
  toolAgentMode?: "disabled" | "planning_only" | "shadow" | "enabled";
  providerMode?: ToolAgentProviderMode;
  envEnabled?: boolean;
  maxSteps?: number;
  signal?: AbortSignal;
  referenceTemplates?: unknown;
  targetInspection?: unknown;
  decisionProvider?: ToolDecisionProvider;
  llmClient?: LlmDecisionClient;
  llm?: LangChainLikeLlm;
}

export interface ToolAgentDispatchResult {
  result: FinishResult;
  loopResult?: ToolAgentLoopResult;
  messages: ToolAgentWsMessage[];
  events: ToolAgentEvent[];
}

export function shouldUseToolAgentWorkflow(input: Pick<ToolAgentDispatchInput, "mode" | "toolAgentMode" | "envEnabled">): boolean {
  if (input.mode === "chat") return false;
  if (input.envEnabled !== true) return false;
  if (input.toolAgentMode === "planning_only") return true;
  return false;
}

export function createPlanningOnlyDecisionProvider(input: ToolAgentDispatchInput): ToolDecisionProvider {
  return async (state: DocxToolAgentState): Promise<ToolDecision> => {
    if (!hasPlanningInputs(input)) {
      return {
        summary: "Missing reference or target context",
        observations: ["planning_only requires referenceDocId/targetDocId or provided referenceTemplates/targetInspection"],
        reason: "Need explicit reference and target information before planning.",
        toolName: "ask_user",
        args: {
          missing: ["referenceDocId/referenceTemplates", "targetDocId/targetInspection"],
        },
      };
    }

    if (state.stepCount === 1) {
      return {
        summary: "Generate candidate fill plan",
        observations: [],
        reason: "Planning-only adapter starts with candidate plan generation.",
        toolName: "generate_fill_plan",
        args: {
          referenceDocId: input.referenceDocId,
          targetDocId: input.targetDocId,
          docId: input.docId,
          referenceTemplates: input.referenceTemplates,
          targetInspection: input.targetInspection,
          userGoal: input.userInput,
          includeDiagnostics: true,
        },
      };
    }

    if (state.stepCount === 2) {
      return {
        summary: "Dry-run candidate plan",
        observations: [],
        reason: "Validate candidate plan without writing.",
        toolName: "dry_run_fill_plan",
        args: {
          plan: state.executionPlan,
          targetDocId: input.targetDocId,
          targetInspection: input.targetInspection,
          includeDiagnostics: true,
        },
      };
    }

    if (state.stepCount === 3) {
      return {
        summary: "Verify current target state",
        observations: [],
        reason: "Read-only verification after planning-only dry-run.",
        toolName: "verify_docx",
        args: {
          plan: state.executionPlan,
          dryRunResult: state.dryRun,
          targetDocId: input.targetDocId,
          targetInspection: input.targetInspection,
          includeDiagnostics: true,
        },
      };
    }

    return {
      summary: "Planning-only Tool Agent completed",
      observations: [],
      reason: "Finished planning-only adapter flow.",
      toolName: "finish",
      args: {
        status: "success",
        summary: "Planning-only Tool Agent completed.",
      },
    };
  };
}

export async function dispatchToolAgentWorkflow(input: ToolAgentDispatchInput): Promise<ToolAgentDispatchResult> {
  const messages: ToolAgentWsMessage[] = [];
  const events: ToolAgentEvent[] = [];

  try {
    clearToolsForTest();
    const availableTools = createSafeToolSet();
    for (const tool of availableTools) {
      registerTool(tool);
    }

    const providerResolution = resolveDecisionProvider(input, availableTools);
    if (!providerResolution.ok) {
      const result: FinishResult = {
        status: "failed",
        summary: providerResolution.error,
      };
      messages.push({
        type: "summary",
        data: {
          result: "failed",
          summary_text: result.summary,
          detail: "",
          failed_tasks: ["tool_agent_provider"],
        },
      });
      return {
        result,
        messages,
        events,
      };
    }

    const decisionProvider = providerResolution.decisionProvider;
    const loopResult = await runToolAgentLoop({
      userInput: input.userInput,
      docId: input.docId,
      referenceDocId: input.referenceDocId,
      targetDocId: input.targetDocId,
      maxSteps: input.maxSteps,
      decisionProvider,
      onEvent: event => {
        events.push(event);
        messages.push(...mapToolAgentEventToWsMessages(event));
      },
    });

    return {
      result: loopResult.result,
      loopResult,
      messages,
      events,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: FinishResult = {
      status: "failed",
      summary: `Tool Agent dispatch failed: ${message}`,
    };
    messages.push({
      type: "summary",
      data: {
        result: "failed",
        summary_text: result.summary,
        detail: "",
        failed_tasks: ["tool_agent"],
      },
    });
    return {
      result,
      messages,
      events,
    };
  }
}

function resolveDecisionProvider(
  input: ToolAgentDispatchInput,
  availableTools: ToolDefinition[],
): { ok: true; decisionProvider: ToolDecisionProvider } | { ok: false; error: string } {
  const providerMode = input.providerMode || "static_planning_only";

  if (input.decisionProvider) {
    return { ok: true, decisionProvider: input.decisionProvider };
  }

  if (input.llmClient) {
    return {
      ok: true,
      decisionProvider: createLlmDecisionProvider({
        client: input.llmClient,
        availableTools,
        policy: "planning_only",
        maxRetries: 1,
      }),
    };
  }

  if (providerMode === "llm_planning_only" && input.llm) {
    return {
      ok: true,
      decisionProvider: createLlmDecisionProvider({
        client: createLangChainDecisionClient(input.llm, {
          signal: input.signal,
          timeoutMs: 90000,
        }),
        availableTools,
        policy: "planning_only",
        maxRetries: 1,
      }),
    };
  }

  if (providerMode === "mock_llm") {
    return {
      ok: false,
      error: "Tool Agent providerMode=mock_llm requires decisionProvider or llmClient.",
    };
  }

  if (providerMode === "llm_planning_only") {
    return {
      ok: false,
      error: "Tool Agent providerMode=llm_planning_only requires decisionProvider, llmClient, or llm.",
    };
  }

  return {
    ok: true,
    decisionProvider: createPlanningOnlyDecisionProvider(input),
  };
}

function hasPlanningInputs(input: ToolAgentDispatchInput): boolean {
  const hasReference = Boolean(input.referenceTemplates || input.referenceDocId);
  const hasTarget = Boolean(input.targetInspection || input.targetDocId || input.docId);
  return hasReference && hasTarget;
}
