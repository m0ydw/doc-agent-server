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
import { z } from "zod";
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

// Zod schema for ExecutionPlan validation
const CandidateTargetSchema = z.object({
  nodeId: z.string(),
  ref: z.string(),
  tableIndex: z.number().optional(),
  row: z.number(),
  col: z.number(),
  confidence: z.number(),
  reason: z.string(),
  constraintScores: z.map(z.string(), z.number()).optional(),
  copyStyleFromReferenceNodeId: z.string().optional(),
});

const FillPlanSchema = z.object({
  fieldId: z.string(),
  semanticMeaning: z.string(),
  candidateTargets: z.array(CandidateTargetSchema),
  selectedTarget: CandidateTargetSchema.optional(),
  confidence: z.number(),
  constraints: z.array(z.object({
    type: z.enum(["single_target", "avoid_readonly", "prefer_multiline", "prefer_repeated_section"]),
    weight: z.number(),
  })),
  sectionContext: z.string(),
});

const ExecutionPlanSchema = z.object({
  planId: z.string(),
  docId: z.string(),
  schemaId: z.string(),
  fillPlans: z.array(FillPlanSchema),
  metadata: z.object({
    totalFields: z.number(),
    highConfidenceCount: z.number(),
    mappedCount: z.number().optional(),
    lowConfidenceCount: z.number().optional(),
    failedReasons: z.array(z.string()).optional(),
    generatedAt: z.string(),
  }),
});

/**
 * 创建 Document Filler 节点函数
 */
export function createDocumentFillerNode() {
  return async (state: typeof AgentState.State, config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
    const docId = state.targetDocId || state.docId;
    const logs: string[] = [];

    try {
      logs.push("[DocumentFiller] Starting document filling...");
      console.log(`[DocumentFiller] 目标文档: ${docId}`);

      // 1. 读取执行计划
      const planJson = state.executionPlan;
      if (!planJson) {
        logs.push("[DocumentFiller] No execution plan found");
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocumentFiller",
          success: false,
          workflowError: "写入失败：没有找到执行计划。",
        };
      }

      // 增强 JSON 解析和 Zod 校验
      let plan: ExecutionPlan;
      try {
        const parsed = JSON.parse(planJson);
        const validated = ExecutionPlanSchema.safeParse(parsed);
        if (!validated.success) {
          logs.push(`[DocumentFiller] Invalid execution plan JSON: ${validated.error.message}`);
          console.error(`[DocumentFiller] ❌ Zod 校验失败:`, validated.error.issues);
          return {
            executionLog: logs.join("\n"),
            delegationStep: (state.delegationStep ?? 0) + 1,
            lastAgent: "DocumentFiller",
            success: false,
            workflowError: "执行计划 JSON 格式无效",
          };
        }
        plan = validated.data as ExecutionPlan;
      } catch (err) {
        logs.push(`[DocumentFiller] Failed to parse execution plan JSON: ${(err as Error).message}`);
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocumentFiller",
          success: false,
          workflowError: "执行计划 JSON 解析失败",
        };
      }

      logs.push(`[DocumentFiller] Loaded plan: ${plan.planId}, ${plan.fillPlans.length} fill plans`);

      // 增强空计划检查
      const executablePlans = plan.fillPlans.filter(p => p.selectedTarget && p.confidence >= 0.5);
      if (executablePlans.length === 0) {
        logs.push("[DocumentFiller] No executable write actions. Refusing to report success for 0/0 writes.");
        console.warn(`[DocumentFiller] ⚠️ 没有可执行的写入动作！fillPlans=${plan.fillPlans.length}, executablePlans=0`);
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

      // 增强日志
      console.log(`[DocumentFiller] ✅ 找到 ${executablePlans.length} 个可执行的写入动作`);

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
          workflowError: `Dry-run 验证失败: ${dryRunResult.errors.join(", ")}`,
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
          workflowError: `写入失败：${failCount} 个字段写入失败`,
        };
      }

      commitTransaction(transaction.id);
      logs.push(`[DocumentFiller] Transaction committed: ${transaction.id}`);

      // 增强日志
      console.log(`[DocumentFiller] ✅ 写入完成：${successCount}/${writeResults.length} 成功`);

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
        workflowError: `写入异常: ${msg}`,
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
