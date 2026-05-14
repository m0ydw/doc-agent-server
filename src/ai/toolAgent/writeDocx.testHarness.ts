import type { RawCell } from "../workflow/nodes/docAnalyst/types";
import { createWriteDocxTool, WriteDocxArgsSchema, type WriteDocxResult } from "./tools/writeDocxTool";

type HarnessStatus = "passed" | "failed";

interface HarnessCaseResult {
  name: string;
  status: HarnessStatus;
  detail: string;
  adapterCallCount: number;
  resultStatus?: string;
}

interface MockCellInput {
  tableIndex?: number;
  row?: number;
  col?: number;
  ref?: string;
  text?: string;
}

export async function runWriteDocxHarnessScenarios(): Promise<HarnessCaseResult[]> {
  const results: HarnessCaseResult[] = [];

  results.push(await runGuardCase("approval confirmed=false blocks", {
    approval: { confirmed: false, approvedActionIds: ["a1"] },
  }, result => result.allowed === false));

  results.push(await runGuardCase("approval approvedActionIds empty blocks", {
    approval: { confirmed: true, approvedActionIds: [] },
  }, result => result.allowed === false));

  results.push(await runGuardCase("dry-run missing blocks", {
    dryRunResult: undefined,
  }, result => result.allowed === false));

  results.push(await runGuardCase("dry-run failed blocks", {
    dryRunResult: { status: "failed", issues: [], checkedActions: [] },
  }, result => result.allowed === false));

  results.push(await runGuardCase("dry-run blocked blocks", {
    dryRunResult: { status: "blocked", issues: [], checkedActions: [] },
  }, result => result.allowed === false));

  results.push(await runGuardCase("reference equals target blocks", {
    plan: basePlan({ referenceDocId: "target-doc" }),
  }, result => result.allowed === false));

  results.push(await runGuardCase("low confidence blocks by default", {
    plan: basePlan({ actions: [baseAction({ confidence: 0.5 })] }),
  }, result => result.allowed === false));

  results.push(await runExecuteCase("low confidence allowed reaches write checks", {
    plan: basePlan({ actions: [baseAction({ confidence: 0.5 })] }),
    options: { allowLowConfidence: true },
  }, {
    cells: [mockCell({ ref: "current-ref" })],
    expectAdapterCalls: 1,
    expectResultStatus: "success",
  }));

  results.push(await runGuardCase("needs_review blocks by default", {
    plan: basePlan({ actions: [baseAction({ type: "needs_review" })] }),
  }, result => result.allowed === false));

  results.push(await runExecuteCase("unapproved action is skipped", {
    plan: basePlan({
      actions: [
        baseAction({ actionId: "a1", valuePreview: "approved" }),
        baseAction({ actionId: "a2", valuePreview: "not approved", target: { tableIndex: 0, row: 0, col: 1 } }),
      ],
    }),
    approval: { confirmed: true, approvedActionIds: ["a1"] },
  }, {
    cells: [mockCell({ ref: "current-ref" })],
    expectAdapterCalls: 1,
    expectSkipped: true,
  }));

  results.push(await runGuardCase("missing target blocks", {
    plan: basePlan({ actions: [baseAction({ target: undefined })] }),
  }, result => result.allowed === false));

  results.push(await runGuardCase("missing expected text blocks", {
    plan: basePlan({ actions: [baseAction({ valuePreview: undefined, source: undefined })] }),
  }, result => result.allowed === false));

  results.push(await runGuardCase("ref-only target blocks", {
    plan: basePlan({ actions: [baseAction({ target: { ref: "old-plan-ref" } })] }),
  }, result => result.allowed === false));

  results.push(await runExecuteCase("current cell not found blocks without adapter", {}, {
    cells: [],
    expectAdapterCalls: 0,
    expectResultStatus: "blocked",
  }));

  results.push(await runExecuteCase("current cell without ref blocks without adapter", {}, {
    cells: [mockCell({ ref: undefined })],
    expectAdapterCalls: 0,
    expectResultStatus: "blocked",
  }));

  results.push(await runExecuteCase("adapter throw fails action", {}, {
    cells: [mockCell({ ref: "current-ref" })],
    adapterThrows: true,
    expectAdapterCalls: 1,
    expectResultStatus: "failed",
  }));

  results.push(await runExecuteCase("successful write applies action", {}, {
    cells: [mockCell({ ref: "current-ref" })],
    expectAdapterCalls: 1,
    expectResultStatus: "success",
    expectApplied: true,
  }));

  return results;
}

async function runGuardCase(
  name: string,
  overrides: Partial<Parameters<typeof makeArgs>[0]>,
  assertion: (result: { allowed: boolean; reason?: string }) => boolean
): Promise<HarnessCaseResult> {
  const calls: unknown[] = [];
  const tool = createWriteDocxTool({
    fileExists: docId => docId === "target-doc",
    parseTargetDocument: async () => ({ tables: [{ cells: [mockCell({ ref: "current-ref" })] }] }),
    writeCellText: async (...args) => { calls.push(args); return "mock write"; },
  });
  const args = makeArgs(overrides);
  const parsedArgs = WriteDocxArgsSchema.parse(args);
  const guardResult = await tool.guard?.(parsedArgs, { userInput: "harness", targetDocId: "target-doc" });
  const passed = assertion(guardResult || { allowed: true }) && calls.length === 0;
  return {
    name,
    status: passed ? "passed" : "failed",
    detail: guardResult?.reason || "allowed",
    adapterCallCount: calls.length,
  };
}

async function runExecuteCase(
  name: string,
  overrides: Partial<Parameters<typeof makeArgs>[0]>,
  expected: {
    cells: RawCell[];
    adapterThrows?: boolean;
    expectAdapterCalls: number;
    expectResultStatus?: WriteDocxResult["status"];
    expectApplied?: boolean;
    expectSkipped?: boolean;
  }
): Promise<HarnessCaseResult> {
  const calls: unknown[] = [];
  const tool = createWriteDocxTool({
    fileExists: docId => docId === "target-doc",
    parseTargetDocument: async () => ({ tables: [{ cells: expected.cells }] }),
    writeCellText: async (...args) => {
      calls.push(args);
      if (expected.adapterThrows) throw new Error("mock adapter failure");
      return "mock write";
    },
  });
  const args = WriteDocxArgsSchema.parse(makeArgs(overrides));
  const result = await tool.execute(args, { userInput: "harness", targetDocId: "target-doc" }) as WriteDocxResult;
  const appliedOk = !expected.expectApplied || result.results.some(item => item.status === "applied");
  const skippedOk = !expected.expectSkipped || result.results.some(item => item.status === "skipped");
  const passed = calls.length === expected.expectAdapterCalls
    && (!expected.expectResultStatus || result.status === expected.expectResultStatus)
    && appliedOk
    && skippedOk
    && !result.results.some(item => item.status === "applied" && expected.expectAdapterCalls === 0);

  return {
    name,
    status: passed ? "passed" : "failed",
    detail: `result=${result.status}`,
    adapterCallCount: calls.length,
    resultStatus: result.status,
  };
}

function makeArgs(overrides: Partial<{
  plan: unknown;
  dryRunResult: unknown;
  approval: { confirmed: boolean; approvedActionIds: string[] };
  options: Record<string, unknown>;
}> = {}) {
  return {
    plan: overrides.plan ?? basePlan(),
    dryRunResult: Object.prototype.hasOwnProperty.call(overrides, "dryRunResult")
      ? overrides.dryRunResult
      : { status: "pass", issues: [], checkedActions: [] },
    targetDocId: "target-doc",
    approval: overrides.approval ?? { confirmed: true, approvedActionIds: ["a1"] },
    options: overrides.options ?? {},
  };
}

function basePlan(overrides: Partial<{
  referenceDocId: string;
  targetDocId: string;
  actions: unknown[];
}> = {}) {
  return {
    version: "tool-agent-plan-v1",
    mode: "candidate_only",
    referenceDocId: overrides.referenceDocId ?? "reference-doc",
    targetDocId: overrides.targetDocId ?? "target-doc",
    actions: overrides.actions ?? [baseAction()],
  };
}

function baseAction(overrides: Partial<{
  actionId: string;
  type: "fill_cell" | "copy_text" | "skip" | "needs_review";
  target: unknown;
  source: unknown;
  valuePreview: string;
  confidence: number;
}> = {}) {
  return {
    actionId: overrides.actionId ?? "a1",
    type: overrides.type ?? "fill_cell",
    source: Object.prototype.hasOwnProperty.call(overrides, "source")
      ? overrides.source
      : { textPreview: "expected text" },
    target: Object.prototype.hasOwnProperty.call(overrides, "target")
      ? overrides.target
      : { tableIndex: 0, row: 0, col: 0, ref: "old-plan-ref" },
    valuePreview: Object.prototype.hasOwnProperty.call(overrides, "valuePreview")
      ? overrides.valuePreview
      : "expected text",
    confidence: overrides.confidence ?? 0.95,
    reason: "harness candidate",
  };
}

function mockCell(input: MockCellInput): RawCell {
  return {
    tableIndex: input.tableIndex ?? 0,
    row: input.row ?? 0,
    col: input.col ?? 0,
    ref: input.ref || "",
    nodeId: "",
    text: input.text || "",
    rowspan: 1,
    colspan: 1,
  };
}
