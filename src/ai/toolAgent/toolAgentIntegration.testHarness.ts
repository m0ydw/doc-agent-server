import type { RawCell } from "../workflow/nodes/docAnalyst/types";
import type { ToolAgentEvent } from "./events";
import { runToolAgentLoop, type ToolDecisionProvider } from "./toolAgentLoop";
import { clearToolsForTest, listTools, registerTool } from "./toolRegistry";
import { createPlanningTools } from "./tools/planningTools";
import { createReadOnlyDocumentTools } from "./tools/readOnlyTools";
import { createVerificationTools } from "./tools/verificationTools";
import { createWriteDocxTool } from "./tools/writeDocxTool";
import type { ToolDefinition } from "./toolTypes";

type HarnessStatus = "passed" | "failed";

interface IntegrationHarnessResult {
  name: string;
  status: HarnessStatus;
  detail: string;
  eventTypes?: string[];
  toolHistory?: string[];
  adapterCallCount?: number;
}

interface MockWriteRuntime {
  adapterCalls: Array<{ docId: string; ref: string; text: string }>;
}

export async function runToolAgentIntegrationHarnessScenarios(): Promise<IntegrationHarnessResult[]> {
  const results: IntegrationHarnessResult[] = [];

  results.push(runRegistryExplicitRegistrationScenario());
  results.push(runDuplicateRegisterScenario());
  results.push(await runLoopFinishScenario());
  results.push(await runLoopToolNotFoundScenario());
  results.push(await runPlanningOnlyHappyPathScenario());
  results.push(await runWriteDocxBlockedScenario());
  results.push(await runWriteDocxMockSuccessScenario());
  results.push(await runMaxStepsScenario());

  clearToolsForTest();
  return results;
}

function runRegistryExplicitRegistrationScenario(): IntegrationHarnessResult {
  clearToolsForTest();
  const tools = [
    ...createReadOnlyDocumentTools(),
    ...createPlanningTools(),
    ...createVerificationTools(),
    createMockWriteDocxTool(),
  ];
  for (const tool of tools) registerTool(tool);

  const toolNames = listTools().map(tool => tool.name).sort();
  const expectedNames = [
    "inspect_documents",
    "inspect_table_structure",
    "inspect_sdk_cell_text",
    "extract_reference_templates",
    "generate_fill_plan",
    "dry_run_fill_plan",
    "verify_docx",
    "write_docx",
  ].sort();
  const passed = toolNames.length === expectedNames.length
    && expectedNames.every(name => toolNames.includes(name));

  return {
    name: "registry explicit registration",
    status: passed ? "passed" : "failed",
    detail: `registered=${toolNames.join(",")}`,
  };
}

function runDuplicateRegisterScenario(): IntegrationHarnessResult {
  clearToolsForTest();
  const tool = createMockNoopTool("inspect_documents");
  let threw = false;
  try {
    registerTool(tool);
    registerTool(tool);
  } catch {
    threw = true;
  }

  const passed = threw && listTools().length === 1;
  clearToolsForTest();
  return {
    name: "duplicate register throws",
    status: passed ? "passed" : "failed",
    detail: passed ? "duplicate registration was rejected" : "duplicate registration did not fail as expected",
  };
}

async function runLoopFinishScenario(): Promise<IntegrationHarnessResult> {
  clearToolsForTest();
  const events: ToolAgentEvent[] = [];
  const result = await runToolAgentLoop({
    userInput: "finish harness",
    decisionProvider: async () => ({
      summary: "finish",
      observations: [],
      reason: "finish now",
      toolName: "finish",
      args: { status: "success", summary: "done" },
    }),
    onEvent: event => { events.push(event); },
  });

  const eventTypes = events.map(event => event.type);
  const passed = result.result.status === "success"
    && eventTypes.join(">") === "tool_agent_start>tool_agent_decision>tool_agent_finish"
    && result.state.toolHistory.length === 0;

  return buildLoopResult("loop finish", passed, result.result.summary, events, result.state.toolHistory.map(entry => entry.toolName));
}

async function runLoopToolNotFoundScenario(): Promise<IntegrationHarnessResult> {
  clearToolsForTest();
  const events: ToolAgentEvent[] = [];
  const result = await runToolAgentLoop({
    userInput: "tool not found harness",
    decisionProvider: async () => ({
      summary: "write missing",
      observations: [],
      reason: "write_docx intentionally not registered",
      toolName: "write_docx",
      args: {},
    }),
    onEvent: event => { events.push(event); },
  });

  const eventTypes = events.map(event => event.type);
  const passed = result.result.status === "failed"
    && eventTypes.includes("tool_error")
    && eventTypes.at(-1) === "tool_agent_finish";

  return buildLoopResult("loop tool not found", passed, result.result.summary, events, result.state.toolHistory.map(entry => entry.toolName));
}

async function runPlanningOnlyHappyPathScenario(): Promise<IntegrationHarnessResult> {
  clearToolsForTest();
  for (const tool of createPlanningTools()) registerTool(tool);
  for (const tool of createVerificationTools()) registerTool(tool);

  const events: ToolAgentEvent[] = [];
  const decisions: ToolDecisionProvider = async state => {
    if (state.stepCount === 1) {
      return {
        summary: "generate plan",
        observations: [],
        reason: "mock reference and target structures are supplied",
        toolName: "generate_fill_plan",
        args: {
          referenceTemplates: mockReferenceTemplates(),
          targetInspection: mockTargetInspection(""),
          includeDiagnostics: true,
        },
      };
    }
    if (state.stepCount === 2) {
      return {
        summary: "dry run",
        observations: [],
        reason: "validate generated plan",
        toolName: "dry_run_fill_plan",
        args: {
          plan: state.executionPlan,
          targetInspection: mockTargetInspection(""),
        },
      };
    }
    if (state.stepCount === 3) {
      return {
        summary: "verify",
        observations: [],
        reason: "read-only verify generated plan",
        toolName: "verify_docx",
        args: {
          plan: state.executionPlan,
          dryRunResult: state.dryRun,
          targetInspection: mockTargetInspection(""),
        },
      };
    }
    return finishDecision("planning-only done");
  };

  const result = await runToolAgentLoop({
    userInput: "planning-only harness",
    maxSteps: 6,
    decisionProvider: decisions,
    onEvent: event => { events.push(event); },
  });

  const history = result.state.toolHistory.map(entry => entry.toolName);
  const eventTypes = events.map(event => event.type);
  const passed = result.result.status === "success"
    && history.join(">") === "generate_fill_plan>dry_run_fill_plan>verify_docx"
    && !history.includes("write_docx")
    && hasOrderedToolEvents(eventTypes, ["generate_fill_plan", "dry_run_fill_plan", "verify_docx"], events);

  return buildLoopResult("planning-only happy path", passed, result.result.summary, events, history);
}

async function runWriteDocxBlockedScenario(): Promise<IntegrationHarnessResult> {
  clearToolsForTest();
  const runtime: MockWriteRuntime = { adapterCalls: [] };
  registerTool(createMockWriteDocxTool(runtime));
  const events: ToolAgentEvent[] = [];

  const result = await runToolAgentLoop({
    userInput: "write blocked harness",
    targetDocId: "target-doc",
    decisionProvider: async () => ({
      summary: "blocked write",
      observations: [],
      reason: "approval is false",
      toolName: "write_docx",
      args: {
        plan: mockCandidatePlan(),
        dryRunResult: mockDryRunResult(),
        targetDocId: "target-doc",
        approval: { confirmed: false, approvedActionIds: ["a1"] },
        options: {},
      },
    }),
    onEvent: event => { events.push(event); },
  });

  const eventTypes = events.map(event => event.type);
  const passed = result.result.status === "blocked"
    && runtime.adapterCalls.length === 0
    && eventTypes.includes("tool_agent_blocked")
    && !eventTypes.includes("tool_result");

  return {
    ...buildLoopResult("write_docx blocked path", passed, result.result.summary, events, result.state.toolHistory.map(entry => entry.toolName)),
    adapterCallCount: runtime.adapterCalls.length,
  };
}

async function runWriteDocxMockSuccessScenario(): Promise<IntegrationHarnessResult> {
  clearToolsForTest();
  const runtime: MockWriteRuntime = { adapterCalls: [] };
  registerTool(createMockWriteDocxTool(runtime));
  const events: ToolAgentEvent[] = [];

  const decisions: ToolDecisionProvider = async state => {
    if (state.stepCount === 1) {
      return {
        summary: "mock write",
        observations: [],
        reason: "approval and dry-run are valid",
        toolName: "write_docx",
        args: {
          plan: mockCandidatePlan(),
          dryRunResult: mockDryRunResult(),
          targetDocId: "target-doc",
          approval: { confirmed: true, approvedActionIds: ["a1"] },
          options: {},
        },
      };
    }
    return finishDecision("mock write done");
  };

  const result = await runToolAgentLoop({
    userInput: "write success harness",
    targetDocId: "target-doc",
    maxSteps: 4,
    decisionProvider: decisions,
    onEvent: event => { events.push(event); },
  });

  const writeResult = result.state.writeResult as { status?: string; appliedActionCount?: number; results?: Array<{ status?: string }> } | undefined;
  const passed = result.result.status === "success"
    && writeResult?.status === "success"
    && writeResult.appliedActionCount === 1
    && Boolean(writeResult.results?.some(item => item.status === "applied"))
    && runtime.adapterCalls.length === 1;

  return {
    ...buildLoopResult("write_docx mock success path", passed, result.result.summary, events, result.state.toolHistory.map(entry => entry.toolName)),
    adapterCallCount: runtime.adapterCalls.length,
  };
}

async function runMaxStepsScenario(): Promise<IntegrationHarnessResult> {
  clearToolsForTest();
  registerTool(createMockNoopTool("inspect_documents"));
  const events: ToolAgentEvent[] = [];
  const result = await runToolAgentLoop({
    userInput: "max steps harness",
    maxSteps: 2,
    decisionProvider: async () => ({
      summary: "keep going",
      observations: [],
      reason: "never finishes",
      toolName: "inspect_documents",
      args: {},
    }),
    onEvent: event => { events.push(event); },
  });

  const passed = result.result.status === "failed"
    && result.state.stepCount === 2
    && /步|step|max|最大|瓒/.test(result.result.summary);

  return buildLoopResult("maxSteps stops loop", passed, result.result.summary, events, result.state.toolHistory.map(entry => entry.toolName));
}

function createMockWriteDocxTool(runtime: MockWriteRuntime = { adapterCalls: [] }): ToolDefinition {
  return createWriteDocxTool({
    fileExists: docId => docId === "target-doc",
    parseTargetDocument: async () => ({ tables: [{ cells: [mockRawCell({ ref: "current-ref" })] }] }),
    writeCellText: async (docId, ref, text) => {
      runtime.adapterCalls.push({ docId, ref, text });
      return "mock write";
    },
  });
}

function createMockNoopTool(name: "inspect_documents"): ToolDefinition {
  return {
    name,
    description: "Mock no-op inspection tool for integration harness only.",
    permission: "read",
    argsSchema: emptyArgsSchema(),
    resultSchema: emptyResultSchema(),
    execute: async () => ({ ok: true }),
  };
}

function emptyArgsSchema() {
  return {
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  } as ToolDefinition["argsSchema"];
}

function emptyResultSchema() {
  return {
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  } as ToolDefinition["resultSchema"];
}

function mockReferenceTemplates() {
  return {
    templates: [{
      tableIndex: 0,
      fieldCandidates: [{
        label: "Name",
        valuePreview: "Alice",
        tableIndex: 0,
        row: 0,
        col: 0,
      }],
    }],
  };
}

function mockTargetInspection(textPreview: string) {
  return {
    tables: [{
      index: 0,
      cells: [
        { tableIndex: 0, row: 0, col: 0, textPreview: "Name", ref: "label-ref" },
        { tableIndex: 0, row: 0, col: 1, textPreview, ref: "target-ref" },
      ],
    }],
  };
}

function mockCandidatePlan() {
  return {
    version: "tool-agent-plan-v1",
    mode: "candidate_only",
    referenceDocId: "reference-doc",
    targetDocId: "target-doc",
    actions: [{
      actionId: "a1",
      type: "fill_cell",
      source: { textPreview: "Alice" },
      target: { tableIndex: 0, row: 0, col: 0, ref: "old-plan-ref" },
      valuePreview: "Alice",
      confidence: 0.95,
      reason: "integration harness candidate",
    }],
  };
}

function mockDryRunResult() {
  return {
    status: "pass",
    issues: [],
    checkedActions: [{
      actionId: "a1",
      type: "fill_cell",
      status: "ok",
      confidence: 0.95,
      targetExists: true,
    }],
  };
}

function mockRawCell(input: { ref?: string; text?: string }): RawCell {
  return {
    tableIndex: 0,
    row: 0,
    col: 0,
    ref: input.ref || "",
    nodeId: "",
    text: input.text || "",
    rowspan: 1,
    colspan: 1,
  };
}

function finishDecision(summary: string) {
  return {
    summary,
    observations: [],
    reason: summary,
    toolName: "finish" as const,
    args: { status: "success" as const, summary },
  };
}

function buildLoopResult(
  name: string,
  passed: boolean,
  detail: string,
  events: ToolAgentEvent[],
  toolHistory: string[]
): IntegrationHarnessResult {
  return {
    name,
    status: passed ? "passed" : "failed",
    detail,
    eventTypes: events.map(event => event.type),
    toolHistory,
  };
}

function hasOrderedToolEvents(
  eventTypes: string[],
  expectedToolNames: string[],
  events: ToolAgentEvent[]
): boolean {
  if (eventTypes[0] !== "tool_agent_start") return false;
  for (const toolName of expectedToolNames) {
    const decisionIndex = events.findIndex(event => event.type === "tool_agent_decision"
      && "decision" in event
      && event.decision.toolName === toolName);
    const startIndex = events.findIndex(event => event.type === "tool_start"
      && "toolName" in event
      && event.toolName === toolName);
    const resultIndex = events.findIndex(event => event.type === "tool_result"
      && "toolName" in event
      && event.toolName === toolName);
    if (decisionIndex < 0 || startIndex < 0 || resultIndex < 0) return false;
    if (!(decisionIndex < startIndex && startIndex < resultIndex)) return false;
  }
  return eventTypes.at(-1) === "tool_agent_finish";
}
