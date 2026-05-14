/**
 * ================================================================
 * wsAgentHandler Tool Agent ProviderMode 入口级 diagnostic / smoke harness
 *
 * 验证目标：
 * - ws entry 传入 toolAgentProviderMode 时，resolveToolAgentProviderModeForEntry 能正确驱动
 * - llm_planning_only + has llm → 实际调用 mockLlm
 * - llm_planning_only + no llm → fallback static
 * - mock_llm → fallback static
 * - 非法值 → fallback static
 * - safe tools 不包含 write_docx
 * ================================================================
 */

import type { LlmDecisionClient } from "../toolAgent/llmDecisionProvider";
import type { LangChainLikeLlm } from "../toolAgent/llmDecisionClientAdapter";
import { dispatchToolAgentWorkflow } from "../toolAgent/toolAgentDispatchAdapter";
import { clearToolsForTest, listTools } from "../toolAgent/toolRegistry";
import { registerSafeToolSet } from "../toolAgent/toolSets";
import { buildToolAgentDispatchInputFromWsEntry } from "./wsAgentHandler";

type HarnessStatus = "passed" | "failed";

interface HarnessResult {
  name: string;
  status: HarnessStatus;
  detail: string;
}

export async function runWsAgentHandlerProviderModeHarness(): Promise<HarnessResult[]> {
  const results: HarnessResult[] = [];

  results.push(testWsEntryLlmPlanningOnlyWithLlm());
  results.push(testWsEntryLlmPlanningOnlyNoLlm());
  results.push(testWsEntryMockLlmFallsBack());
  results.push(testWsEntryInvalidProviderMode());
  results.push(testWsEntryNoProviderMode());
  results.push(testSafeToolsExcludesWriteDocx());
  results.push(await testWsEntryLlmPlanningOnlyDispatchCallsLlm());
  results.push(await testWsEntryLlmPlanningOnlyNoLlmDispatchDoesNotCallLlm());
  results.push(await testWsEntryMockLlmDispatchDoesNotFail());
  results.push(await testWsEntryInvalidProviderModeDispatchDoesNotThrow());

  clearToolsForTest();
  return results;
}

// ================================================================
// 纯 helper 测试（不调用 dispatch）
// ================================================================

function testWsEntryLlmPlanningOnlyWithLlm(): HarnessResult {
  const input = buildToolAgentDispatchInputFromWsEntry({
    message: "fill doc",
    docId: "target-doc",
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    mode: "workflow",
    toolAgentMode: "planning_only",
    rawToolAgentProviderMode: "llm_planning_only",
    envEnabled: true,
    hasLlm: true,
    llm: createMockLlm(),
  });
  const passed = input.providerMode === "llm_planning_only" && input.llm !== undefined;
  return {
    name: "ws entry: llm_planning_only + has llm → providerMode=llm_planning_only, llm passed",
    status: passed ? "passed" : "failed",
    detail: `providerMode=${input.providerMode}, llm=${input.llm !== undefined ? "present" : "absent"}`,
  };
}

function testWsEntryLlmPlanningOnlyNoLlm(): HarnessResult {
  const input = buildToolAgentDispatchInputFromWsEntry({
    message: "fill doc",
    docId: "target-doc",
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    mode: "workflow",
    toolAgentMode: "planning_only",
    rawToolAgentProviderMode: "llm_planning_only",
    envEnabled: true,
    hasLlm: false,
  });
  const passed = input.providerMode === "static_planning_only" && input.llm === undefined;
  return {
    name: "ws entry: llm_planning_only + no llm → fallback static",
    status: passed ? "passed" : "failed",
    detail: `providerMode=${input.providerMode}, llm=${input.llm !== undefined ? "present" : "absent"}`,
  };
}

function testWsEntryMockLlmFallsBack(): HarnessResult {
  const input = buildToolAgentDispatchInputFromWsEntry({
    message: "fill doc",
    docId: "target-doc",
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    mode: "workflow",
    toolAgentMode: "planning_only",
    rawToolAgentProviderMode: "mock_llm",
    envEnabled: true,
    hasLlm: true,
    llm: createMockLlm(),
  });
  const passed = input.providerMode === "static_planning_only" && input.llm === undefined;
  return {
    name: "ws entry: mock_llm → fallback static, llm not passed",
    status: passed ? "passed" : "failed",
    detail: `providerMode=${input.providerMode}, llm=${input.llm !== undefined ? "present" : "absent"}`,
  };
}

function testWsEntryInvalidProviderMode(): HarnessResult {
  const input = buildToolAgentDispatchInputFromWsEntry({
    message: "fill doc",
    docId: "target-doc",
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    mode: "workflow",
    toolAgentMode: "planning_only",
    rawToolAgentProviderMode: "bad_value",
    envEnabled: true,
    hasLlm: true,
    llm: createMockLlm(),
  });
  const passed = input.providerMode === "static_planning_only" && input.llm === undefined;
  return {
    name: "ws entry: invalid providerMode → fallback static, no throw",
    status: passed ? "passed" : "failed",
    detail: `providerMode=${input.providerMode}, llm=${input.llm !== undefined ? "present" : "absent"}`,
  };
}

function testWsEntryNoProviderMode(): HarnessResult {
  const input = buildToolAgentDispatchInputFromWsEntry({
    message: "fill doc",
    docId: "target-doc",
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
    mode: "workflow",
    toolAgentMode: "planning_only",
    envEnabled: true,
    hasLlm: true,
    llm: createMockLlm(),
  });
  const passed = input.providerMode === "static_planning_only" && input.llm === undefined;
  return {
    name: "ws entry: no providerMode → defaults to static",
    status: passed ? "passed" : "failed",
    detail: `providerMode=${input.providerMode}, llm=${input.llm !== undefined ? "present" : "absent"}`,
  };
}

function testSafeToolsExcludesWriteDocx(): HarnessResult {
  clearToolsForTest();
  registerSafeToolSet();
  const names = listTools().map(tool => tool.name).sort();
  const passed = !names.includes("write_docx");
  return {
    name: "safe tools still excludes write_docx",
    status: passed ? "passed" : "failed",
    detail: `tools=${names.join(",")}`,
  };
}

// ================================================================
// dispatch 级别测试（调用 dispatchToolAgentWorkflow）
// ================================================================

async function testWsEntryLlmPlanningOnlyDispatchCallsLlm(): Promise<HarnessResult> {
  registerMockDocs();
  let invokeCount = 0;
  const responses = [
    decisionJson("inspect_documents", {
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
    }),
    finishJson("blocked", "mock llm stopped after safe inspection"),
  ];
  const mockLlm: LangChainLikeLlm = {
    async invoke(): Promise<string> {
      invokeCount += 1;
      return responses.shift() || finishJson("success", "done");
    },
  };
  try {
    const input = buildToolAgentDispatchInputFromWsEntry({
      message: "fill Alice",
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
      mode: "workflow",
      toolAgentMode: "planning_only",
      rawToolAgentProviderMode: "llm_planning_only",
      envEnabled: true,
      hasLlm: true,
      llm: mockLlm,
      maxSteps: 3,
    });
    const result = await dispatchToolAgentWorkflow(input);
    const history = result.loopResult?.state.toolHistory.map(entry => entry.toolName) || [];
    const passed = result.result.status === "blocked"
      && invokeCount >= 1
      && history.includes("inspect_documents")
      && !listTools().some(tool => tool.name === "write_docx");
    return {
      name: "ws entry dispatch: llm_planning_only + has llm → mockLlm.invoke called",
      status: passed ? "passed" : "failed",
      detail: `status=${result.result.status}, history=${history.join(">")}, invokeCount=${invokeCount}`,
    };
  } finally {
    unregisterMockDocs();
  }
}

async function testWsEntryLlmPlanningOnlyNoLlmDispatchDoesNotCallLlm(): Promise<HarnessResult> {
  registerMockDocs();
  try {
    const input = buildToolAgentDispatchInputFromWsEntry({
      message: "fill Alice",
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
      mode: "workflow",
      toolAgentMode: "planning_only",
      rawToolAgentProviderMode: "llm_planning_only",
      envEnabled: true,
      hasLlm: false,
      maxSteps: 4,
    });
    const result = await dispatchToolAgentWorkflow(input);
    // Should fall back to static_planning_only, which uses createPlanningOnlyDecisionProvider
    // With referenceTemplates/targetInspection missing, it will ask_user or finish
    const hasNoLlmProviderError = result.result.summary?.includes("requires decisionProvider, llmClient, or llm");
    const passed = result.result.status !== "failed" || !hasNoLlmProviderError;
    return {
      name: "ws entry dispatch: llm_planning_only + no llm → no llm_planning_only failed error",
      status: passed ? "passed" : "failed",
      detail: `status=${result.result.status}, hasNoLlmProviderError=${hasNoLlmProviderError}`,
    };
  } finally {
    unregisterMockDocs();
  }
}

async function testWsEntryMockLlmDispatchDoesNotFail(): Promise<HarnessResult> {
  registerMockDocs();
  try {
    const input = buildToolAgentDispatchInputFromWsEntry({
      message: "fill Alice",
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
      mode: "workflow",
      toolAgentMode: "planning_only",
      rawToolAgentProviderMode: "mock_llm",
      envEnabled: true,
      hasLlm: true,
      llm: createMockLlm(),
      maxSteps: 4,
    });
    const result = await dispatchToolAgentWorkflow(input);
    // mock_llm falls back to static_planning_only, so no mock_llm failed error
    const hasMockLlmError = result.result.summary?.includes("providerMode=mock_llm requires");
    const passed = !hasMockLlmError;
    return {
      name: "ws entry dispatch: mock_llm → fallback static, no mock_llm failed",
      status: passed ? "passed" : "failed",
      detail: `status=${result.result.status}, hasMockLlmError=${hasMockLlmError}`,
    };
  } finally {
    unregisterMockDocs();
  }
}

async function testWsEntryInvalidProviderModeDispatchDoesNotThrow(): Promise<HarnessResult> {
  registerMockDocs();
  try {
    const input = buildToolAgentDispatchInputFromWsEntry({
      message: "fill Alice",
      docId: "target-doc",
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
      mode: "workflow",
      toolAgentMode: "planning_only",
      rawToolAgentProviderMode: "invalid_value",
      envEnabled: true,
      hasLlm: true,
      llm: createMockLlm(),
      maxSteps: 4,
    });
    let threw = false;
    let result;
    try {
      result = await dispatchToolAgentWorkflow(input);
    } catch {
      threw = true;
    }
    // invalid value falls back to static_planning_only, should not throw
    // status may be "failed" because static planning needs referenceTemplates/targetInspection
    // but the key is: no throw, and no mock_llm or llm_planning_only error
    const hasMockLlmError = result?.result.summary?.includes("providerMode=mock_llm requires") ?? false;
    const hasLlmPlanningOnlyError = result?.result.summary?.includes("requires decisionProvider, llmClient, or llm") ?? false;
    const passed = !threw && !hasMockLlmError && !hasLlmPlanningOnlyError;
    return {
      name: "ws entry dispatch: invalid providerMode → no throw, fallback static",
      status: passed ? "passed" : "failed",
      detail: `threw=${threw}, status=${result?.result.status}, hasMockLlmError=${hasMockLlmError}, hasLlmPlanningOnlyError=${hasLlmPlanningOnlyError}`,
    };
  } finally {
    unregisterMockDocs();
  }
}

// ================================================================
// helpers
// ================================================================

function createMockLlm(): LangChainLikeLlm {
  return {
    async invoke(): Promise<string> {
      return finishJson("success", "mock llm invoked");
    },
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

function registerMockDocs(): void {
  const { fileRegistry } = require("../../services/fileRegistry");
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
  const { fileRegistry } = require("../../services/fileRegistry");
  fileRegistry.unregister("ref-doc");
  fileRegistry.unregister("target-doc");
}
