/**
 * ================================================================
 * Document Filler 节点入口
 * ================================================================
 *
 * 独立 LangGraph 节点：
 * - 读取 ExecutionPlan
 * - 实际写入
 * - 重试 + 验证
 * - 事务安全
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../../state";
import type { ExecutionPlan, ExecutionOptions, WriteResult } from "./types";
import { executeDryRun } from "./dryRunner";
import { writeValue } from "./writer";
import {
  createTransaction,
  addWriteToTransaction,
  commitTransaction,
  rollbackTransaction,
} from "./transactionManager";
import { parseDocument } from "../docAnalyst/parser";

/**
 * 创建 Document Filler 节点函数
 */
export function createDocumentFillerNode() {
  return async (state: typeof AgentState.State, config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
    const docId = state.targetDocId || state.docId;
    const logs: string[] = [];

    try {
      logs.push("[DocumentFiller] Starting document filling...");

      // 1. 读取执行计划
      const planJson = state.executionPlan;
      if (!planJson) {
        logs.push("[DocumentFiller] No execution plan found");
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocumentFiller",
          success: false,
        };
      }

      const plan: ExecutionPlan = JSON.parse(planJson);
      logs.push(`[DocumentFiller] Loaded plan: ${plan.planId}, ${plan.fillPlans.length} fill plans`);

      const executablePlans = plan.fillPlans.filter(p => p.selectedTarget && p.confidence >= 0.5);
      if (executablePlans.length === 0) {
        logs.push("[DocumentFiller] No executable write actions. Refusing to report success for 0/0 writes.");
        return {
          transaction: JSON.stringify({
            id: "",
            status: "rolled_back",
            writes: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }),
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocumentFiller",
          success: false,
          workflowError: "写入失败：执行计划为空或没有可执行 targetNodeId/ref。",
        };
      }

      // 2. 执行 dry-run
      const options: ExecutionOptions = {
        dryRun: false,
        validateOnly: false,
      };

      const dryRunResult = executeDryRun(plan);
      logs.push(`[DocumentFiller] Dry-run result: valid=${dryRunResult.valid}, errors=${dryRunResult.errors.length}, warnings=${dryRunResult.warnings.length}, estimatedWrites=${dryRunResult.estimatedWrites}`);

      if (!dryRunResult.valid) {
        logs.push(`[DocumentFiller] Dry-run failed: ${dryRunResult.errors.join(", ")}`);
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocumentFiller",
          success: false,
        };
      }

      // 3. 创建事务
      const transaction = createTransaction();
      logs.push(`[DocumentFiller] Created transaction: ${transaction.id}`);

      // 4. 执行写入
      const writeResults: WriteResult[] = [];
      let successCount = 0;
      let failCount = 0;

      for (const fillPlan of executablePlans) {
        if (!fillPlan.selectedTarget) {
          logs.push(`[DocumentFiller] No target for field: ${fillPlan.fieldId}`);
          continue;
        }

        if (fillPlan.confidence < 0.5) {
          logs.push(`[DocumentFiller] Low confidence for field: ${fillPlan.fieldId} (${fillPlan.confidence})`);
          continue;
        }

        const writeResult = await writeValue(
          docId,
          fillPlan.selectedTarget.ref,
          fillPlan.semanticMeaning,
          fillPlan.selectedTarget.tableIndex ?? 0
        );

        writeResults.push(writeResult);
        addWriteToTransaction(transaction.id, writeResult);

        if (writeResult.success) {
          successCount++;
          logs.push(`[DocumentFiller] Wrote ${fillPlan.fieldId} to ${fillPlan.selectedTarget.ref}: "${fillPlan.semanticMeaning}"`);
        } else {
          failCount++;
          logs.push(`[DocumentFiller] Failed to write ${fillPlan.fieldId}: ${writeResult.error}`);
        }
      }

      const verificationFailures = await verifyWrites(docId, executablePlans);
      if (verificationFailures.length > 0) {
        failCount += verificationFailures.length;
        logs.push(`[DocumentFiller] Verification failed: ${verificationFailures.join("; ")}`);
      }

      // 5. 提交或回滚事务
      if (failCount > 0) {
        logs.push(`[DocumentFiller] Rolling back transaction due to ${failCount} failures`);
        const rollbackSuccess = await rollbackTransaction(transaction.id, docId);
        logs.push(`[DocumentFiller] Rollback ${rollbackSuccess ? "successful" : "failed"}`);

        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocumentFiller",
          success: false,
        };
      }

      commitTransaction(transaction.id);
      logs.push(`[DocumentFiller] Transaction committed: ${transaction.id}`);

      // 返回 state patch
      return {
        transactionId: transaction.id,
        transaction: JSON.stringify(transaction),
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "DocumentFiller",
        success: true,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logs.push(`[DocumentFiller] Error: ${msg}`);
      console.error("[DocumentFiller] Error:", err);

      return {
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "DocumentFiller",
        success: false,
      };
    }
  };
}

// 重新导出类型
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

export type {
  ExecutionPlan,
  ExecutionOptions,
  WriteResult,
  Transaction,
} from "./types";
