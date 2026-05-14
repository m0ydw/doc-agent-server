import type { ToolAgentEvent } from "./events";
import type { LlmDecisionClient } from "./llmDecisionProvider";
import type { LangChainLikeLlm } from "./llmDecisionClientAdapter";
import { dispatchToolAgentWorkflow, shouldUseToolAgentWorkflow } from "./toolAgentDispatchAdapter";
import { mapToolAgentEventToWsMessages } from "./toolAgentEventAdapter";
import { clearToolsForTest, listTools } from "./toolRegistry";
import { registerSafeToolSet } from "./toolSets";
import { fileRegistry } from "../../services/fileRegistry";

type HarnessStatus = "passed" | "failed";

interface DispatchHarnessResult {
  name: string;
  status: HarnessStatus;
  detail: string;
}

export async function runToolAgentDispatchAdapterHarnessScenarios(): Promise<DispatchHarnessResult[]> {
  const results: DispatchHarnessResult[] = [];

  results.push(testShouldUseToolAgentWorkflow());
  results.push(testSafeToolSet());
  results.push(testEventAdapter());
  results.push(await testPlanningOnlyBlockedPath());
  results.push(await testPlanningOnlyHappyPath());
  results.push(await testDecisionProviderPriority());
  results.push(await testLlmClientProvider());
  results.push(await testLlmProviderViaAdapter());
  results.push(await testLlmPlanningOnlyMissingProvider());
  results.push(await testMockLlmMissingProvider());
  results.push(await testMockLlmRejectsWriteDocx());
  results.push(await testMockLlmInvalidJsonRetry());
  results.push(await testMockLlmConsecutiveFailure());
  results.push(testSafeToolsAfterDispatch());

  clearToolsForTest();
  return results;
}

function testShouldUseToolAgentWorkflow(): DispatchHarnessResult {
  const cases = [
    shouldUseToolAgentWorkflow({ mode: "chat", toolAgentMode: "planning_only", envEnabled: true }) === false,
    shouldUseToolAgentWorkflow({ mode: "workflow", toolAgentMode: "planning_only", envEnabled: false }) === false,
    shouldUseToolAgentWorkflow({ mode: "workflow", envEnabled: true }) === false,
    shouldUseToolAgentWorkflow({ mode: "workflow", toolAgentMode: "planning_only", envEnabled: true }) === true,
    shouldUseToolAgentWorkflow({ mode: "workflow", toolAgentMode: "enabled", envEnabled: true }) === false,
    shouldUseToolAgentWorkflow({ mode: "workflow", toolAgentMode: "shadow", envEnabled: true }) === false,
  ];
  const passed = cases.every(Boolean);
  return {
    name: "shouldUseToolAgentWorkflow",
    status: passed ? "passed" : "failed",
    detail: `cases=${cases.map(Boolean).join(",")}`,
  };
}

function testSafeToolSet(): DispatchHarnessResult {
  clearToolsForTest();
  registerSafeToolSet();
  const names = listTools().map(tool => tool.name).sort();
  const expected = [
    "inspect_documents",
    "inspect_table_structure",
    "inspect_sdk_cell_text",
    "extract_reference_templates",
    "generate_fill_plan",
    "dry_run_fill_plan",
    "verify_docx",
  ].sort();
  const passed = names.length === expected.length
    && expected.every(name => names.includes(name))
    && !names.includes("write_docx");
  return {
    name: "safe tool set excludes write_docx",
    status: passed ? "passed" : "failed",
    detail: `tools=${names.join(",")}`,
  };
}

function testEventAdapter(): DispatchHarnessResult {
  const events: ToolAgentEvent[] = [
    {
      type: "tool_agent_start",
      step: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      userInput: "hi",
      maxSteps: 3,
    },
    {
      type: "tool_start",
      step: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
      toolName: "generate_fill_plan",
      args: { sample: true },
    },
    {
      type: "tool_result",
      step: 1,
      timestamp: "2026-01-01T00:00:02.000Z",
      toolName: "generate_fill_plan",
      result: { status: "success", diagnostics: { generatedActionCount: 1 } },
    },
    {
      type: "tool_error",
      step: 2,
      timestamp: "2026-01-01T00:00:03.000Z",
      error: { toolName: "dry_run_fill_plan", message: "bad" },
    },
    {
      type: "tool_agent_blocked",
      step: 2,
      timestamp: "2026-01-01T00:00:04.000Z",
      reason: "blocked",
    },
    {
      type: "tool_agent_finish",
      step: 3,
      timestamp: "2026-01-01T00:00:05.000Z",
      result: { status: "success", summary: "done" },
    },
  ];
  const wsTypes = events.flatMap(event => mapToolAgentEventToWsMessages(event).map(message => message.type));
  const passed = ["phase_start", "phase_status", "tool_start", "tool_result", "error", "warning", "summary"]
    .every(type => wsTypes.includes(type));
  return {
    name: "event adapter maps to existing ws events",
    status: passed ? "passed" : "failed",
    detail: `wsTypes=${wsTypes.join(",")}`,
  };
}

async function testPlanningOnlyBlockedPath(): Promise<DispatchHarnessResult> {
  const result = await dispatchToolAgentWorkflow({
    userInput: "missing docs",
    toolAgentMode: "planning_only",
    envEnabled: true,
    maxSteps: 4,
  });
  const messageTypes = result.messages.map(message => message.type);
  const passed = (result.result.status === "needs_user_input" || result.result.status === "blocked" || result.result.status === "failed")
    && messageTypes.includes("summary")
    && !listTools().some(tool => tool.name === "write_docx");
  return {
    name: "planning-only dispatch blocked path",
    status: passed ? "passed" : "failed",
    detail: `status=${result.result.status}, messages=${messageTypes.join(",")}`,
  };
}

async function testPlanningOnlyHappyPath(): Promise<DispatchHarnessResult> {
  const result = await dispatchToolAgentWorkflow({
    userInput: "fill Alice into target",
    toolAgentMode: "planning_only",
    envEnabled: true,
    maxSteps: 6,
    referenceTemplates: mockReferenceTemplates(),
    targetInspection: mockTargetInspection(""),
  });
  const history = result.loopResult?.state.toolHistory.map(entry => entry.toolName) || [];
  const passed = result.result.status === "success"
    && history.join(">") === "generate_fill_plan>dry_run_fill_plan>verify_docx"
    && !history.includes("write_docx")
    && result.messages.some(message => message.type === "tool_result")
    && !listTools().some(tool => tool.name === "write_docx");
  return {
    name: "planning-only dispatch happy path",
    status: passed ? "passed" : "failed",
    detail: `status=${result.result.status}, history=${history.join(">")}`,
  };
}

async function testDecisionProviderPriority(): Promise<DispatchHarnessResult> {
  let llmClientCalls = 0;
  const result = await dispatchToolAgentWorkflow({
    userInput: "finish immediately",
    toolAgentMode: "planning_only",
    providerMode: "llm_planning_only",
    envEnabled: true,
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    maxSteps: 3,
    decisionProvider: async () => ({
      summary: "manual finish",
      observations: [],
      reason: "decisionProvider has priority",
      toolName: "finish",
      args: { status: "success", summary: "manual finish" },
    }),
    llmClient: {
      async complete(): Promise<string> {
        llmClientCalls += 1;
        return decisionJson("write_docx", {});
      },
    },
  });
  const passed = result.result.status === "success" && llmClientCalls === 0;
  return {
    name: "decisionProvider injection priority",
    status: passed ? "passed" : "failed",
    detail: `status=${result.result.status}, llmClientCalls=${llmClientCalls}`,
  };
}

async function testLlmClientProvider(): Promise<DispatchHarnessResult> {
  registerMockDocs();
  const llmClient = createSequenceLlmClient([
    decisionJson("inspect_documents", {
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
    }),
    finishJson("blocked", "mock llm stopped after safe inspection"),
  ]);
  try {
    const result = await dispatchToolAgentWorkflow({
      userInput: "fill Alice",
      toolAgentMode: "planning_only",
      providerMode: "llm_planning_only",
      envEnabled: true,
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
      maxSteps: 3,
      llmClient,
    });
    const history = result.loopResult?.state.toolHistory.map(entry => entry.toolName) || [];
    const passed = result.result.status === "blocked"
      && history.join(">") === "inspect_documents"
      && !listTools().some(tool => tool.name === "write_docx");
    return {
      name: "llmClient provider drives loop",
      status: passed ? "passed" : "failed",
      detail: `status=${result.result.status}, history=${history.join(">")}, calls=${llmClient.callCount}`,
    };
  } finally {
    unregisterMockDocs();
  }
}

async function testLlmProviderViaAdapter(): Promise<DispatchHarnessResult> {
  registerMockDocs();
  let invokeCount = 0;
  const responses = [
    decisionJson("inspect_documents", {
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
    }),
    finishJson("blocked", "mock adapter stopped after safe inspection"),
  ];
  const llm: LangChainLikeLlm = {
    async invoke(): Promise<string> {
      invokeCount += 1;
      return responses.shift() || finishJson("success", "done");
    },
  };
  try {
    const result = await dispatchToolAgentWorkflow({
      userInput: "fill Alice",
      toolAgentMode: "planning_only",
      providerMode: "llm_planning_only",
      envEnabled: true,
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
      maxSteps: 3,
      llm,
    });
    const history = result.loopResult?.state.toolHistory.map(entry => entry.toolName) || [];
    const passed = result.result.status === "blocked"
      && invokeCount >= 2
      && history.join(">") === "inspect_documents"
      && !listTools().some(tool => tool.name === "write_docx");
    return {
      name: "llm provider via adapter drives loop",
      status: passed ? "passed" : "failed",
      detail: `status=${result.result.status}, history=${history.join(">")}, invokeCount=${invokeCount}`,
    };
  } finally {
    unregisterMockDocs();
  }
}

async function testLlmPlanningOnlyMissingProvider(): Promise<DispatchHarnessResult> {
  const result = await dispatchToolAgentWorkflow({
    userInput: "fill Alice",
    toolAgentMode: "planning_only",
    providerMode: "llm_planning_only",
    envEnabled: true,
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
  });
  const passed = result.result.status === "failed"
    && result.result.summary.includes("requires decisionProvider, llmClient, or llm");
  return {
    name: "llm_planning_only missing provider fails",
    status: passed ? "passed" : "failed",
    detail: `status=${result.result.status}, summary=${result.result.summary}`,
  };
}

async function testMockLlmMissingProvider(): Promise<DispatchHarnessResult> {
  const result = await dispatchToolAgentWorkflow({
    userInput: "fill Alice",
    toolAgentMode: "planning_only",
    providerMode: "mock_llm",
    envEnabled: true,
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
  });
  const passed = result.result.status === "failed"
    && result.result.summary.includes("providerMode=mock_llm requires");
  return {
    name: "mock_llm missing provider fails",
    status: passed ? "passed" : "failed",
    detail: `status=${result.result.status}, summary=${result.result.summary}`,
  };
}

async function testMockLlmRejectsWriteDocx(): Promise<DispatchHarnessResult> {
  const llmClient = createSequenceLlmClient([
    decisionJson("write_docx", {}),
    decisionJson("write_docx", {}),
  ]);
  const result = await dispatchToolAgentWorkflow({
    userInput: "try write",
    toolAgentMode: "planning_only",
    providerMode: "llm_planning_only",
    envEnabled: true,
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    maxSteps: 3,
    llmClient,
  });
  const passed = result.result.status === "failed"
    && !result.loopResult?.state.toolHistory.some(entry => entry.toolName === "write_docx")
    && !listTools().some(tool => tool.name === "write_docx");
  return {
    name: "mock LLM write_docx rejected",
    status: passed ? "passed" : "failed",
    detail: `status=${result.result.status}, calls=${llmClient.callCount}`,
  };
}

async function testMockLlmInvalidJsonRetry(): Promise<DispatchHarnessResult> {
  registerMockDocs();
  const llmClient = createSequenceLlmClient([
    "not json",
    decisionJson("inspect_documents", {
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
    }),
    finishJson("blocked", "stop after retry smoke"),
  ]);
  try {
    const result = await dispatchToolAgentWorkflow({
      userInput: "fill Alice",
      toolAgentMode: "planning_only",
      providerMode: "llm_planning_only",
      envEnabled: true,
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
    maxSteps: 3,
    llmClient,
  });
  const history = result.loopResult?.state.toolHistory.map(entry => entry.toolName) || [];
    const passed = result.result.status === "blocked"
      && history.includes("inspect_documents")
      && llmClient.callCount >= 2;
    return {
      name: "mock LLM invalid JSON retry",
      status: passed ? "passed" : "failed",
      detail: `status=${result.result.status}, history=${history.join(">")}, calls=${llmClient.callCount}`,
    };
  } finally {
    unregisterMockDocs();
  }
}

async function testMockLlmConsecutiveFailure(): Promise<DispatchHarnessResult> {
  const llmClient = createSequenceLlmClient(["not json", "still not json"]);
  const result = await dispatchToolAgentWorkflow({
    userInput: "fill Alice",
    toolAgentMode: "planning_only",
    providerMode: "llm_planning_only",
    envEnabled: true,
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    maxSteps: 3,
    llmClient,
  });
  const passed = result.result.status === "failed";
  return {
    name: "mock LLM consecutive failure",
    status: passed ? "passed" : "failed",
    detail: `status=${result.result.status}, calls=${llmClient.callCount}`,
  };
}

function testSafeToolsAfterDispatch(): DispatchHarnessResult {
  const names = listTools().map(tool => tool.name).sort();
  const passed = !names.includes("write_docx");
  return {
    name: "safe tools assertion after dispatch",
    status: passed ? "passed" : "failed",
    detail: `tools=${names.join(",")}`,
  };
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
    version: "1",
    mode: "candidate_only",
    actions: [{
      actionId: "a1",
      type: "fill_cell",
      source: {
        docId: "ref-doc",
        tableIndex: 0,
        row: 0,
        col: 0,
        textPreview: "Alice",
      },
      target: {
        docId: "target-doc",
        tableIndex: 0,
        row: 0,
        col: 1,
      },
      label: "Name",
      valuePreview: "Alice",
      confidence: 0.9,
      reason: "mock plan",
    }],
  };
}

function decisionJson(toolName: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    summary: `choose ${toolName}`,
    observations: ["mock"],
    reason: "mock provider decision",
    toolName,
    args,
  });
}

function finishJson(status: string, summary: string): string {
  return decisionJson("finish", { status, summary });
}

function createSequenceLlmClient(responses: string[]): LlmDecisionClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async complete(): Promise<string> {
      callCount += 1;
      return responses.shift() || "not json";
    },
  };
}

function registerMockDocs(): void {
  fileRegistry.register({
    docId: "ref-doc",
    docPath: "mock-reference.docx",
    originalName: "mock-reference.docx",
    roomName: "mock-reference",
    uploadedAt: "2026-01-01T00:00:00.000Z",
  });
  fileRegistry.register({
    docId: "target-doc",
    docPath: "mock-target.docx",
    originalName: "mock-target.docx",
    roomName: "mock-target",
    uploadedAt: "2026-01-01T00:00:00.000Z",
  });
}

function unregisterMockDocs(): void {
  fileRegistry.unregister("ref-doc");
  fileRegistry.unregister("target-doc");
}
