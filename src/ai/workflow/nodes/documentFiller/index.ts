import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../../state";
import type { ExecutionPlan, WriteResult } from "./types";
import { executeDryRun } from "./dryRunner";
import { writeValue } from "./writer";
import {
  createTransaction,
  addWriteToTransaction,
  commitTransaction,
  rollbackTransaction,
} from "./transactionManager";
import { parseDocument } from "../docAnalyst/parser";
import { ExecutionPlanSchema, normalizeExecutionPlan } from "../sharedSchemas";

const MISSING_EXECUTION_PLAN = "缺少执行计划：planId/docId/schemaId/fillPlans 未生成";

function failedFillerPatch(
  state: typeof AgentState.State,
  logs: string[],
  message: string,
  transaction?: unknown,
): Partial<typeof AgentState.State> {
  return {
    transaction: transaction ? JSON.stringify(transaction) : state.transaction,
    executionLog: logs.join("\n"),
    delegationStep: (state.delegationStep ?? 0) + 1,
    lastAgent: "DocumentFiller",
    documentFillerStatus: "failed",
    success: false,
    retryable: false,
    workflowError: message,
  };
}

function parseExecutionPlan(planJson: string | undefined): { plan?: ExecutionPlan; error?: string } {
  if (!planJson || planJson.trim() === "" || planJson.trim() === "{}") {
    return { error: MISSING_EXECUTION_PLAN };
  }

  try {
    const parsed = JSON.parse(planJson);
    const normalized = normalizeExecutionPlan(parsed);
    const validated = ExecutionPlanSchema.safeParse(normalized);
    if (!validated.success) {
      const missingCoreFields = validated.error.issues.some(issue =>
        ["planId", "docId", "schemaId", "fillPlans", "metadata"].includes(String(issue.path[0] ?? "")),
      );
      return {
        error: missingCoreFields
          ? MISSING_EXECUTION_PLAN
          : `执行计划结构校验失败：${validated.error.message}`,
      };
    }
    return { plan: validated.data as ExecutionPlan };
  } catch (err) {
    return { error: `执行计划 JSON 解析失败：${(err as Error).message}` };
  }
}

export function createDocumentFillerNode() {
  return async (state: typeof AgentState.State, _config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
    const docId = state.targetDocId || state.docId;
    const logs: string[] = [];

    try {
      logs.push("[DocumentFiller] Starting document filling...");

      const parsedPlan = parseExecutionPlan(state.executionPlan);
      if (!parsedPlan.plan) {
        logs.push(`[DocumentFiller] ${parsedPlan.error}`);
        return failedFillerPatch(state, logs, parsedPlan.error || MISSING_EXECUTION_PLAN);
      }

      const plan = parsedPlan.plan;
      logs.push(`[DocumentFiller] Loaded plan: ${plan.planId}, ${plan.fillPlans.length} fill plans`);

      const executablePlans = plan.fillPlans.filter(p => p.selectedTarget && p.confidence >= 0.5);
      if (executablePlans.length === 0) {
        const transaction = {
          id: "",
          status: "rolled_back",
          writes: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        logs.push("[DocumentFiller] No executable write actions");
        return failedFillerPatch(
          state,
          logs,
          "写入失败：执行计划为空或没有可执行 targetNodeId/ref。",
          transaction,
        );
      }

      const dryRunResult = executeDryRun(plan);
      logs.push(`[DocumentFiller] Dry-run result: valid=${dryRunResult.valid}, errors=${dryRunResult.errors.length}, warnings=${dryRunResult.warnings.length}, estimatedWrites=${dryRunResult.estimatedWrites}`);
      if (!dryRunResult.valid) {
        return failedFillerPatch(state, logs, `Dry-run 验证失败：${dryRunResult.errors.join(", ")}`);
      }

      const transaction = createTransaction();
      logs.push(`[DocumentFiller] Created transaction: ${transaction.id}`);

      const writeResults: WriteResult[] = [];
      let failCount = 0;

      for (const fillPlan of executablePlans) {
        const target = fillPlan.selectedTarget;
        if (!target) continue;

        const writeResult = await writeValue(
          docId,
          target.ref,
          fillPlan.semanticMeaning,
          target.tableIndex ?? 0,
        );

        writeResults.push(writeResult);
        addWriteToTransaction(transaction.id, writeResult);

        if (!writeResult.success) {
          failCount++;
          logs.push(`[DocumentFiller] Failed to write ${fillPlan.fieldId}: ${writeResult.error}`);
        } else {
          logs.push(`[DocumentFiller] Wrote ${fillPlan.fieldId} to ${target.ref}: "${fillPlan.semanticMeaning}"`);
        }
      }

      const verificationFailures = await verifyWrites(docId, executablePlans);
      if (verificationFailures.length > 0) {
        failCount += verificationFailures.length;
        logs.push(`[DocumentFiller] Verification failed: ${verificationFailures.join("; ")}`);
      }

      if (failCount > 0) {
        const rollbackSuccess = await rollbackTransaction(transaction.id, docId);
        logs.push(`[DocumentFiller] Rollback ${rollbackSuccess ? "successful" : "failed"}`);
        return failedFillerPatch(state, logs, `写入失败：${failCount} 个字段写入失败`);
      }

      commitTransaction(transaction.id);
      logs.push(`[DocumentFiller] Transaction committed: ${transaction.id}`);

      return {
        transactionId: transaction.id,
        transaction: JSON.stringify(transaction),
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "DocumentFiller",
        documentFillerStatus: "success",
        success: true,
        workflowError: "",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logs.push(`[DocumentFiller] Error: ${msg}`);
      console.error("[DocumentFiller] Error:", err);
      return failedFillerPatch(state, logs, `写入异常：${msg}`);
    }
  };
}

async function verifyWrites(docId: string, fillPlans: ExecutionPlan["fillPlans"]): Promise<string[]> {
  const payload = await parseDocument(docId, true);
  const cells = payload.tables.flatMap(table => table.cells);
  const failures: string[] = [];

  for (const fillPlan of fillPlans) {
    const target = fillPlan.selectedTarget;
    if (!target) continue;

    const cell = cells.find(item => item.ref === target.ref || item.nodeId === target.nodeId);
    if (!cell) {
      failures.push(`${fillPlan.fieldId}: target ref not found after write`);
      continue;
    }

    if (!cell.text.includes(fillPlan.semanticMeaning)) {
      failures.push(`${fillPlan.fieldId}: expected "${fillPlan.semanticMeaning}", got "${cell.text}"`);
    }
  }

  return failures;
}

export const __testing = {
  parseExecutionPlan,
  MISSING_EXECUTION_PLAN,
};

export type {
  ExecutionPlan,
  ExecutionOptions,
  WriteResult,
  Transaction,
} from "./types";
