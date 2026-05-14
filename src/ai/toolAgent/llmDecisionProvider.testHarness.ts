import type { ToolDecision } from "./schemas";
import { createInitialDocxToolAgentState, type DocxToolAgentState } from "./state";
import { createSafeToolSet } from "./toolSets";
import {
  createLlmDecisionProvider,
  createMockLlmDecisionClient,
} from "./llmDecisionProvider";

type HarnessStatus = "passed" | "failed";

interface LlmDecisionProviderHarnessResult {
  name: string;
  status: HarnessStatus;
  detail: string;
}

export async function runLlmDecisionProviderHarnessScenarios(): Promise<LlmDecisionProviderHarnessResult[]> {
  const results: LlmDecisionProviderHarnessResult[] = [];

  results.push(await testValidJsonDecision());
  results.push(await testMarkdownFencedJson());
  results.push(await testInvalidJsonThenRetrySuccess());
  results.push(await testInvalidJsonRetryExhausted());
  results.push(await testInvisibleWriteDocx());
  results.push(await testUnknownTool());
  results.push(await testArgsSchemaFailure());
  results.push(await testMissingReferenceTargetPolicy());
  results.push(await testCannotFinishBeforeDryRun());
  results.push(await testDryRunBlockedPolicy());
  results.push(await testHappyPlanningPathDecisions());

  return results;
}

async function testValidJsonDecision(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    decisionJson("inspect_documents", {}),
  ]);
  const provider = createProvider(client);
  const decision = await provider(createState());
  return result(
    "valid JSON decision",
    decision.toolName === "inspect_documents" && client.callCount === 1,
    `toolName=${decision.toolName}, calls=${client.callCount}`
  );
}

async function testMarkdownFencedJson(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    `\`\`\`json\n${decisionJson("inspect_documents", {})}\n\`\`\``,
  ]);
  const provider = createProvider(client);
  const decision = await provider(createState());
  return result(
    "markdown fenced JSON",
    decision.toolName === "inspect_documents",
    `toolName=${decision.toolName}`
  );
}

async function testInvalidJsonThenRetrySuccess(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    "not json",
    decisionJson("inspect_documents", {}),
  ]);
  const provider = createProvider(client, 1);
  const decision = await provider(createState());
  return result(
    "invalid JSON then retry success",
    decision.toolName === "inspect_documents" && client.callCount === 2,
    `toolName=${decision.toolName}, calls=${client.callCount}`
  );
}

async function testInvalidJsonRetryExhausted(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient(["not json", "still not json"]);
  const provider = createProvider(client, 1);
  const decision = await provider(createState());
  return result(
    "invalid JSON retry exhausted",
    decision.toolName === "finish" && decision.args.status === "failed",
    `toolName=${decision.toolName}, status=${String(decision.args.status)}, calls=${client.callCount}`
  );
}

async function testInvisibleWriteDocx(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    decisionJson("write_docx", {}),
    decisionJson("write_docx", {}),
  ]);
  const provider = createProvider(client, 1);
  const decision = await provider(createState());
  return result(
    "invisible write_docx",
    decision.toolName !== "write_docx" && decision.toolName === "finish",
    `toolName=${decision.toolName}, status=${String(decision.args.status)}`
  );
}

async function testUnknownTool(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    decisionJson("not_a_tool", {}),
    decisionJson("not_a_tool", {}),
  ]);
  const provider = createProvider(client, 1);
  const decision = await provider(createState());
  return result(
    "unknown tool",
    decision.toolName === "finish" && decision.args.status === "failed",
    `toolName=${decision.toolName}, status=${String(decision.args.status)}`
  );
}

async function testArgsSchemaFailure(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    decisionJson("inspect_table_structure", { tableIndex: "bad" }),
    decisionJson("inspect_table_structure", { tableIndex: "bad" }),
  ]);
  const provider = createProvider(client, 1);
  const decision = await provider(createState());
  return result(
    "args schema failure",
    decision.toolName === "finish" && decision.args.status === "failed",
    `toolName=${decision.toolName}, status=${String(decision.args.status)}`
  );
}

async function testMissingReferenceTargetPolicy(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    decisionJson("generate_fill_plan", {}),
    decisionJson("generate_fill_plan", {}),
  ]);
  const provider = createProvider(client, 1);
  const decision = await provider(createInitialDocxToolAgentState({ userInput: "fill docs" }));
  return result(
    "missing reference/target policy",
    decision.toolName === "ask_user",
    `toolName=${decision.toolName}`
  );
}

async function testCannotFinishBeforeDryRun(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    finishJson("success", "done"),
    finishJson("success", "done"),
  ]);
  const provider = createProvider(client, 1);
  const state = createState();
  state.executionPlan = { status: "success", plan: mockPlan() };
  const decision = await provider(state);
  return result(
    "cannot finish before dry_run",
    decision.toolName === "finish" && decision.args.status === "failed",
    `toolName=${decision.toolName}, status=${String(decision.args.status)}`
  );
}

async function testDryRunBlockedPolicy(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    decisionJson("verify_docx", { plan: mockPlan() }),
    decisionJson("verify_docx", { plan: mockPlan() }),
  ]);
  const provider = createProvider(client, 1);
  const state = createState();
  state.executionPlan = { status: "success", plan: mockPlan() };
  state.dryRun = { status: "blocked", issues: [{ code: "DUPLICATE_TARGET" }] };
  const decision = await provider(state);
  return result(
    "dry_run blocked policy",
    decision.toolName === "finish" && decision.args.status === "failed",
    `toolName=${decision.toolName}, status=${String(decision.args.status)}`
  );
}

async function testHappyPlanningPathDecisions(): Promise<LlmDecisionProviderHarnessResult> {
  const client = createMockLlmDecisionClient([
    decisionJson("generate_fill_plan", { referenceDocId: "ref-doc", targetDocId: "target-doc" }),
    decisionJson("dry_run_fill_plan", { plan: mockPlan(), targetDocId: "target-doc" }),
    decisionJson("verify_docx", { plan: mockPlan(), targetDocId: "target-doc" }),
    finishJson("success", "planning complete"),
  ]);
  const provider = createProvider(client);
  const state = createState();

  const first = await provider(state);
  state.stepCount += 1;
  state.executionPlan = { status: "success", plan: mockPlan() };

  const second = await provider(state);
  state.stepCount += 1;
  state.dryRun = { status: "pass", issues: [] };

  const third = await provider(state);
  state.stepCount += 1;
  state.verification = { status: "missing", checks: [] };

  const fourth = await provider(state);
  const names = [first.toolName, second.toolName, third.toolName, fourth.toolName];

  return result(
    "happy planning path decisions",
    names.join(">") === "generate_fill_plan>dry_run_fill_plan>verify_docx>finish"
      && !names.includes("write_docx"),
    `path=${names.join(">")}`
  );
}

function createProvider(client: ReturnType<typeof createMockLlmDecisionClient>, maxRetries = 1) {
  return createLlmDecisionProvider({
    client,
    availableTools: createSafeToolSet(),
    maxRetries,
    policy: "planning_only",
  });
}

function createState(): DocxToolAgentState {
  return createInitialDocxToolAgentState({
    userInput: "Fill target DOCX from reference DOCX.",
    docId: "target-doc",
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    maxSteps: 8,
  });
}

function decisionJson(toolName: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    summary: `choose ${toolName}`,
    observations: ["mock observation"],
    reason: "mock decision",
    toolName,
    args,
  });
}

function finishJson(status: string, summary: string): string {
  return decisionJson("finish", { status, summary });
}

function mockPlan() {
  return {
    version: "1",
    mode: "candidate_only",
    actions: [
      {
        actionId: "a1",
        type: "fill_cell",
        target: { docId: "target-doc", tableIndex: 0, row: 0, col: 1 },
        source: { docId: "ref-doc", tableIndex: 0, row: 0, col: 1, textPreview: "与绘" },
        label: "项目名称",
        valuePreview: "与绘",
        confidence: 0.9,
        reason: "mock",
      },
    ],
  };
}

function result(
  name: string,
  passed: boolean,
  detail: string
): LlmDecisionProviderHarnessResult {
  return {
    name,
    status: passed ? "passed" : "failed",
    detail,
  };
}
