import { FinishResultSchema, ToolDecisionSchema, type FinishResult, type ToolDecision, type ToolError } from "./schemas";
import { createInitialDocxToolAgentState, type DocxToolAgentState } from "./state";
import { getTool } from "./toolRegistry";
import type { ToolAgentEvent } from "./events";
import { nowIso } from "./events";
import type { GuardResult, ToolExecutionContext, ToolHistoryEntry } from "./toolTypes";

export type ToolDecisionProvider = (
  state: DocxToolAgentState
) => Promise<ToolDecision>;

export interface ToolAgentLoopInput {
  userInput: string;
  docId?: string;
  referenceDocId?: string;
  targetDocId?: string;
  maxSteps?: number;
  decisionProvider: ToolDecisionProvider;
  onEvent?: (event: ToolAgentEvent) => void | Promise<void>;
}

export interface ToolAgentLoopResult {
  state: DocxToolAgentState;
  result: FinishResult;
}

export async function runToolAgentLoop(
  input: ToolAgentLoopInput
): Promise<ToolAgentLoopResult> {
  const state = createInitialDocxToolAgentState({
    userInput: input.userInput,
    docId: input.docId,
    referenceDocId: input.referenceDocId,
    targetDocId: input.targetDocId,
    maxSteps: input.maxSteps ?? 12,
  });

  await emit(input, {
    type: "tool_agent_start",
    step: state.stepCount,
    timestamp: nowIso(),
    userInput: state.userInput,
    docId: state.docId,
    referenceDocId: state.referenceDocId,
    targetDocId: state.targetDocId,
    maxSteps: state.maxSteps,
  });

  while (state.stepCount < state.maxSteps) {
    state.stepCount += 1;

    const decisionResult = await getValidatedDecision(input, state);
    if (!decisionResult.ok) {
      return failWithToolError(input, state, decisionResult.error);
    }

    const decision = decisionResult.decision;
    await emit(input, {
      type: "tool_agent_decision",
      step: state.stepCount,
      timestamp: nowIso(),
      decision,
    });

    if (decision.toolName === "finish") {
      const result = buildFinishResult(decision);
      await emitFinish(input, state, result);
      return { state, result };
    }

    if (decision.toolName === "ask_user") {
      state.needsUserInput = true;
      const result: FinishResult = {
        status: "needs_user_input",
        summary: decision.reason || decision.summary || "需要用户补充信息",
        details: decision.args,
      };
      await emit(input, {
        type: "tool_agent_blocked",
        step: state.stepCount,
        timestamp: nowIso(),
        reason: result.summary,
      });
      await emitFinish(input, state, result);
      return { state, result };
    }

    const tool = getTool(decision.toolName);
    if (!tool) {
      return failWithToolError(input, state, {
        toolName: decision.toolName,
        message: `Tool not registered: ${decision.toolName}`,
        code: "TOOL_NOT_FOUND",
      }, decision.args);
    }

    const parsedArgs = tool.argsSchema.safeParse(decision.args);
    if (!parsedArgs.success) {
      return failWithToolError(input, state, {
        toolName: decision.toolName,
        message: `Invalid arguments for tool: ${decision.toolName}`,
        code: "TOOL_ARGS_INVALID",
        details: parsedArgs.error.issues,
      }, decision.args);
    }

    const context = buildExecutionContext(state);
    const guardResult = await runGuard(tool.guard, parsedArgs.data, context);
    if (!guardResult.allowed) {
      const result: FinishResult = {
        status: "blocked",
        summary: guardResult.reason || `Tool blocked: ${decision.toolName}`,
        details: guardResult.warnings,
      };
      await emit(input, {
        type: "tool_agent_blocked",
        step: state.stepCount,
        timestamp: nowIso(),
        reason: result.summary,
        warnings: guardResult.warnings,
      });
      await emitFinish(input, state, result);
      return { state, result };
    }

    const historyEntry: ToolHistoryEntry = {
      step: state.stepCount,
      toolName: decision.toolName,
      args: parsedArgs.data,
      startedAt: nowIso(),
    };
    state.toolHistory.push(historyEntry);

    await emit(input, {
      type: "tool_start",
      step: state.stepCount,
      timestamp: historyEntry.startedAt,
      toolName: decision.toolName,
      args: parsedArgs.data,
    });

    try {
      const result = await tool.execute(parsedArgs.data, context);
      const parsedResult = tool.resultSchema.safeParse(result);
      if (!parsedResult.success) {
        throw new ToolAgentLoopError("TOOL_RESULT_INVALID", `Invalid result from tool: ${decision.toolName}`, parsedResult.error.issues);
      }

      historyEntry.result = parsedResult.data;
      historyEntry.finishedAt = nowIso();
      applyToolResultToState(state, decision.toolName, parsedResult.data);

      await emit(input, {
        type: "tool_result",
        step: state.stepCount,
        timestamp: historyEntry.finishedAt,
        toolName: decision.toolName,
        result: parsedResult.data,
      });
    } catch (error) {
      const toolError = toToolError(decision.toolName, error);
      historyEntry.error = toolError;
      historyEntry.finishedAt = nowIso();
      state.workflowError = toolError.message;

      await emit(input, {
        type: "tool_error",
        step: state.stepCount,
        timestamp: historyEntry.finishedAt,
        error: toolError,
      });

      const result: FinishResult = {
        status: "failed",
        summary: toolError.message,
        details: toolError,
      };
      await emitFinish(input, state, result);
      return { state, result };
    }
  }

  const result: FinishResult = {
    status: "failed",
    summary: `超过最大步骤数：${state.maxSteps}`,
  };
  state.workflowError = result.summary;
  await emitFinish(input, state, result);
  return { state, result };
}

async function getValidatedDecision(
  input: ToolAgentLoopInput,
  state: DocxToolAgentState
): Promise<{ ok: true; decision: ToolDecision } | { ok: false; error: ToolError }> {
  try {
    const decision = await input.decisionProvider(state);
    const parsed = ToolDecisionSchema.safeParse(decision);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          toolName: "decision_provider",
          message: "Invalid tool decision",
          code: "TOOL_DECISION_INVALID",
          details: parsed.error.issues,
        },
      };
    }

    return { ok: true, decision: parsed.data };
  } catch (error) {
    return {
      ok: false,
      error: toToolError("decision_provider", error),
    };
  }
}

function buildFinishResult(decision: ToolDecision): FinishResult {
  const parsed = FinishResultSchema.safeParse(decision.args);
  if (parsed.success) {
    return parsed.data;
  }

  return {
    status: "success",
    summary: decision.summary,
    details: decision.args,
  };
}

function buildExecutionContext(state: DocxToolAgentState): ToolExecutionContext {
  return {
    userInput: state.userInput,
    docId: state.docId,
    referenceDocId: state.referenceDocId,
    targetDocId: state.targetDocId,
  };
}

async function runGuard(
  guard: undefined | ((args: unknown, context: ToolExecutionContext) => GuardResult | Promise<GuardResult>),
  args: unknown,
  context: ToolExecutionContext
): Promise<GuardResult> {
  if (!guard) return { allowed: true };
  return guard(args, context);
}

function applyToolResultToState(
  state: DocxToolAgentState,
  toolName: string,
  result: unknown
): void {
  switch (toolName) {
    case "inspect_documents":
      state.documents = result;
      break;
    case "inspect_table_structure":
      state.tableInspection = result;
      break;
    case "inspect_sdk_cell_text":
      state.sdkTextInspection = result;
      break;
    case "extract_reference_templates":
      state.templateExtraction = result;
      break;
    case "generate_fill_plan":
      state.executionPlan = result;
      break;
    case "dry_run_fill_plan":
      state.dryRun = result;
      break;
    case "write_docx":
      state.writeResult = result;
      break;
    case "verify_docx":
      state.verification = result;
      break;
  }
}

async function failWithToolError(
  input: ToolAgentLoopInput,
  state: DocxToolAgentState,
  error: ToolError,
  args?: unknown
): Promise<ToolAgentLoopResult> {
  state.workflowError = error.message;
  state.toolHistory.push({
    step: state.stepCount,
    toolName: error.toolName,
    args,
    error,
    startedAt: nowIso(),
    finishedAt: nowIso(),
  });

  await emit(input, {
    type: "tool_error",
    step: state.stepCount,
    timestamp: nowIso(),
    error,
  });

  const result: FinishResult = {
    status: "failed",
    summary: error.message,
    details: error,
  };
  await emitFinish(input, state, result);
  return { state, result };
}

async function emitFinish(
  input: ToolAgentLoopInput,
  state: DocxToolAgentState,
  result: FinishResult
): Promise<void> {
  await emit(input, {
    type: "tool_agent_finish",
    step: state.stepCount,
    timestamp: nowIso(),
    result,
  });
}

async function emit(input: ToolAgentLoopInput, event: ToolAgentEvent): Promise<void> {
  await input.onEvent?.(event);
}

function toToolError(toolName: string, error: unknown): ToolError {
  if (error instanceof ToolAgentLoopError) {
    return {
      toolName,
      message: error.message,
      code: error.code,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      toolName,
      message: error.message,
    };
  }

  return {
    toolName,
    message: "Unknown tool error",
    details: error,
  };
}

class ToolAgentLoopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}
