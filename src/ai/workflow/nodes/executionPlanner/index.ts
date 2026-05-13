/**
 * ================================================================
 * Execution Planner 节点入口
 * ================================================================
 *
 * 独立 LangGraph 节点：
 * - 读取 SemanticDocumentSchema
 * - 归一化用户数据
 * - 匹配 + 排名 + 约束
 * - 输出 ExecutionPlan
 */

import { ChatOpenAI } from "@langchain/openai";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { AgentState } from "../../state";
import type { SemanticDocumentSchema, ExecutionPlan, NormalizedUserData } from "./types";
import { normalizeUserData } from "./normalizer";
import { buildExecutionPlan } from "./planBuilder";
import { getSchema } from "../docAnalyst/schema";
import { getTableFillAnalysis } from "../tableFill/store";
import { buildLayoutBasedExecutionPlan } from "../tableFill/planner";

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
 * 创建 Execution Planner 节点函数
 */
export function createExecutionPlannerNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
    const logs: string[] = [];

    try {
      logs.push("[ExecutionPlanner] Starting execution planning...");

      if (state.tableAnalysisId) {
        const analysis = getTableFillAnalysis(state.tableAnalysisId);
        if (!analysis) {
          logs.push(`[ExecutionPlanner] Table analysis not found: ${state.tableAnalysisId}`);
          return {
            executionLog: logs.join("\n"),
            delegationStep: (state.delegationStep ?? 0) + 1,
            lastAgent: "ExecutionPlanner",
            success: false,
            workflowError: "表格分析结果不存在，无法生成写入计划。",
          };
        }

        const { plan, stats } = buildLayoutBasedExecutionPlan(analysis);
        logs.push(`[ExecutionPlanner] Layout plan: recognized=${stats.recognizedFields}, mapped=${stats.mappedFields}, lowConfidence=${stats.lowConfidenceCount}`);
        if (stats.failedReasons.length > 0) {
          logs.push(`[ExecutionPlanner] Failed reasons: ${stats.failedReasons.join("; ")}`);
        }

        // 增强空计划检查
        if (plan.fillPlans.length === 0) {
          console.warn(`[ExecutionPlanner] ⚠️ fillPlans 为空！`);
          return {
            executionPlanId: plan.planId,
            executionPlan: JSON.stringify(plan),
            executionLog: logs.join("\n"),
            delegationStep: (state.delegationStep ?? 0) + 1,
            lastAgent: "ExecutionPlanner",
            success: false,
            workflowError: "执行规划失败：没有生成任何 targetNodeId/ref 级写入动作。",
          };
        }

        // 检查是否有可执行的计划
        const executablePlans = plan.fillPlans.filter(p => p.selectedTarget && p.confidence >= 0.5);
        if (executablePlans.length === 0 || stats.mappedFields === 0) {
          console.warn(`[ExecutionPlanner] ⚠️ 没有可执行的写入动作！executablePlans=${executablePlans.length}, mappedFields=${stats.mappedFields}`);
          return {
            executionPlanId: plan.planId,
            executionPlan: JSON.stringify(plan),
            executionLog: logs.join("\n"),
            delegationStep: (state.delegationStep ?? 0) + 1,
            lastAgent: "ExecutionPlanner",
            success: false,
            workflowError: "执行规划失败：没有可执行的写入动作（所有目标置信度过低或缺失）。",
          };
        }

        // 增强日志
        console.log(`[ExecutionPlanner] ✅ 执行计划生成成功：${plan.fillPlans.length} 个写入动作，${executablePlans.length} 个可执行`);

        return {
          executionPlanId: plan.planId,
          executionPlan: JSON.stringify(plan),
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: true,
        };
      }

      // 1. 读取 SemanticDocumentSchema
      const schemaId = state.semanticSchemaId;
      if (!schemaId) {
        logs.push("[ExecutionPlanner] No schema ID found");
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
        };
      }

      const schema = await getSchema(schemaId);
      if (!schema) {
        logs.push(`[ExecutionPlanner] Schema not found: ${schemaId}`);
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
        };
      }

      logs.push(`[ExecutionPlanner] Loaded schema: ${schema.schemaId}, ${schema.writableCells.length} writable cells`);

      // 2. 归一化用户数据（增加 JSON 校验）
      let extractedData: Record<string, unknown>;
      try {
        extractedData = JSON.parse(state.extractedData || "{}");
      } catch (err) {
        logs.push(`[ExecutionPlanner] Failed to parse extractedData JSON: ${(err as Error).message}`);
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
          workflowError: "用户数据 JSON 解析失败",
        };
      }

      const normalizationResult = normalizeUserData(extractedData);

      logs.push(`[ExecutionPlanner] Normalized data: ${normalizationResult.matchCount}/${normalizationResult.totalCount} fields`);

      if (normalizationResult.matchCount === 0) {
        logs.push("[ExecutionPlanner] No fields to fill");
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
          workflowError: "执行规划失败：没有可填充的字段。",
        };
      }

      // 3. 构建执行计划
      const executionPlan = buildExecutionPlan(schema, normalizationResult.normalized);

      // 增强空计划检查
      if (executionPlan.fillPlans.length === 0) {
        logs.push("[ExecutionPlanner] No fill plans generated");
        return {
          executionPlanId: executionPlan.planId,
          executionPlan: JSON.stringify(executionPlan),
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
          workflowError: "执行规划失败：没有生成任何 targetNodeId/ref 级写入动作。",
        };
      }

      // 检查是否有可执行的计划
      const executablePlans = executionPlan.fillPlans.filter(p => p.selectedTarget && p.confidence >= 0.5);
      if (executablePlans.length === 0) {
        logs.push("[ExecutionPlanner] No executable plans (all selectedTarget missing or low confidence)");
        return {
          executionPlanId: executionPlan.planId,
          executionPlan: JSON.stringify(executionPlan),
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
          workflowError: "执行规划失败：没有可执行的写入动作（所有目标置信度过低或缺失）。",
        };
      }

      logs.push(`[ExecutionPlanner] Built plan: ${executionPlan.fillPlans.length} fill plans, ${executionPlan.metadata.highConfidenceCount} high confidence, ${executablePlans.length} executable`);

      // 4. Zod schema 校验
      const validated = ExecutionPlanSchema.safeParse(executionPlan);
      if (!validated.success) {
        logs.push(`[ExecutionPlanner] Execution plan validation failed: ${validated.error.message}`);
        console.error(`[ExecutionPlanner] ❌ Zod 校验失败:`, validated.error.issues);
        return {
          executionPlanId: executionPlan.planId,
          executionPlan: JSON.stringify(executionPlan),
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
          workflowError: "执行计划 JSON 格式无效",
        };
      }

      // 5. 保存计划
      const planId = executionPlan.planId;
      // 实际实现应该持久化存储

      // 增强日志
      console.log(`[ExecutionPlanner] ✅ 执行计划生成成功：${executionPlan.fillPlans.length} 个写入动作，${executablePlans.length} 个可执行`);

      // 返回 state patch
      return {
        executionPlanId: planId,
        executionPlan: JSON.stringify(executionPlan),
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "ExecutionPlanner",
        success: true,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logs.push(`[ExecutionPlanner] Error: ${msg}`);
      console.error("[ExecutionPlanner] Error:", err);

      return {
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "ExecutionPlanner",
        success: false,
      };
    }
  };
}

// 重新导出类型
export type {
  ExecutionPlan,
  FillPlan,
  CandidateTarget,
  NormalizedUserData,
} from "./types";
