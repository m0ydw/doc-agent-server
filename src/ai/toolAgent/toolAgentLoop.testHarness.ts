import { z } from "zod";
import type { ToolDecision } from "./schemas";
import type { ToolAgentEvent } from "./events";
import { runToolAgentLoop, type ToolAgentLoopResult } from "./toolAgentLoop";
import { clearToolsForTest, registerTool } from "./toolRegistry";

export interface ToolAgentLoopHarnessScenarioResult {
  name: string;
  loopResult: ToolAgentLoopResult;
  eventTypes: string[];
  executeCount: number;
}

type MockToolMode =
  | "success"
  | "guard_blocked"
  | "execute_throws"
  | "invalid_result";

const InspectDocumentsArgsSchema = z.object({
  query: z.string(),
});

const InspectDocumentsResultSchema = z.object({
  ok: z.boolean(),
  source: z.literal("mock_inspect_documents"),
});

export async function runToolAgentLoopHarnessScenarios(): Promise<ToolAgentLoopHarnessScenarioResult[]> {
  const scenarios = [
    runFinishScenario,
    runAskUserScenario,
    runToolSuccessScenario,
    runToolNotFoundScenario,
    runArgsSchemaFailureScenario,
    runResultSchemaFailureScenario,
    runGuardBlockedScenario,
    runToolExecuteThrowsScenario,
    runMaxStepsScenario,
  ];

  const results: ToolAgentLoopHarnessScenarioResult[] = [];
  for (const scenario of scenarios) {
    clearToolsForTest();
    try {
      results.push(await scenario());
    } finally {
      clearToolsForTest();
    }
  }

  return results;
}

async function runFinishScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  return runScenario("finish", [finishDecision()]);
}

async function runAskUserScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  return runScenario("ask_user", [{
    summary: "需要补充参考文档",
    observations: [],
    reason: "缺少 referenceDocId",
    toolName: "ask_user",
    args: { question: "请提供参考文档" },
  }]);
}

async function runToolSuccessScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  registerMockInspectDocumentsTool("success");
  return runScenario("tool_success", [
    inspectDocumentsDecision({ query: "docs" }),
    finishDecision(),
  ]);
}

async function runToolNotFoundScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  return runScenario("tool_not_found", [
    inspectDocumentsDecision({ query: "docs" }),
  ]);
}

async function runArgsSchemaFailureScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  registerMockInspectDocumentsTool("success");
  return runScenario("args_schema_failure", [
    inspectDocumentsDecision({ query: 123 }),
  ]);
}

async function runResultSchemaFailureScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  registerMockInspectDocumentsTool("invalid_result");
  return runScenario("result_schema_failure", [
    inspectDocumentsDecision({ query: "docs" }),
  ]);
}

async function runGuardBlockedScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  registerMockInspectDocumentsTool("guard_blocked");
  return runScenario("guard_blocked", [
    inspectDocumentsDecision({ query: "docs" }),
  ]);
}

async function runToolExecuteThrowsScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  registerMockInspectDocumentsTool("execute_throws");
  return runScenario("execute_throws", [
    inspectDocumentsDecision({ query: "docs" }),
  ]);
}

async function runMaxStepsScenario(): Promise<ToolAgentLoopHarnessScenarioResult> {
  registerMockInspectDocumentsTool("success");
  return runScenario(
    "max_steps",
    [
      inspectDocumentsDecision({ query: "first" }),
      inspectDocumentsDecision({ query: "second" }),
      inspectDocumentsDecision({ query: "third" }),
    ],
    2
  );
}

function registerMockInspectDocumentsTool(mode: MockToolMode): void {
  let executeCount = 0;

  registerTool({
    name: "inspect_documents",
    description: "Mock inspect_documents tool for loop harness only.",
    permission: "read",
    argsSchema: InspectDocumentsArgsSchema,
    resultSchema: InspectDocumentsResultSchema,
    guard: mode === "guard_blocked"
      ? () => ({ allowed: false, reason: "mock guard blocked", warnings: ["mock warning"] })
      : undefined,
    execute: async () => {
      executeCount += 1;
      if (mode === "execute_throws") {
        throw new Error("mock execute failed");
      }
      if (mode === "invalid_result") {
        return { ok: true, source: "invalid_mock_source" };
      }
      return { ok: true, source: "mock_inspect_documents" };
    },
  });

  Object.defineProperty(registerMockInspectDocumentsTool, "lastExecuteCount", {
    value: () => executeCount,
    configurable: true,
  });
}

async function runScenario(
  name: string,
  decisions: ToolDecision[],
  maxSteps?: number
): Promise<ToolAgentLoopHarnessScenarioResult> {
  const events: ToolAgentEvent[] = [];
  let index = 0;

  const loopResult = await runToolAgentLoop({
    userInput: `mock ${name}`,
    docId: "mock-doc",
    referenceDocId: "mock-reference",
    targetDocId: "mock-target",
    maxSteps,
    decisionProvider: async () => decisions[Math.min(index++, decisions.length - 1)],
    onEvent: (event) => {
      events.push(event);
    },
  });

  return {
    name,
    loopResult,
    eventTypes: events.map(event => event.type),
    executeCount: getLastExecuteCount(),
  };
}

function inspectDocumentsDecision(args: Record<string, unknown>): ToolDecision {
  return {
    summary: "Inspect documents",
    observations: [],
    reason: "mock inspection",
    toolName: "inspect_documents",
    args,
  };
}

function finishDecision(): ToolDecision {
  return {
    summary: "Done",
    observations: [],
    reason: "mock finish",
    toolName: "finish",
    args: {
      status: "success",
      summary: "Mock finished",
    },
  };
}

function getLastExecuteCount(): number {
  const maybeGetter = (registerMockInspectDocumentsTool as unknown as {
    lastExecuteCount?: () => number;
  }).lastExecuteCount;

  return maybeGetter?.() ?? 0;
}
