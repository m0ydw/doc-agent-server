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
import { AgentState } from "../../state";
import type { SemanticDocumentSchema, ExecutionPlan, NormalizedUserData } from "./types";
import { normalizeUserData } from "./normalizer";
import { buildExecutionPlan } from "./planBuilder";
import { getSchema } from "../docAnalyst/schema";
import { getTableFillAnalysis } from "../tableFill/store";
import { buildLayoutBasedExecutionPlan } from "../tableFill/planner";

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

        if (plan.fillPlans.length === 0 || stats.mappedFields === 0) {
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

      // 2. 归一化用户数据
      const extractedData = JSON.parse(state.extractedData || "{}");
      const normalizationResult = normalizeUserData(extractedData);

      logs.push(`[ExecutionPlanner] Normalized data: ${normalizationResult.matchCount}/${normalizationResult.totalCount} fields`);

      if (normalizationResult.matchCount === 0) {
        logs.push("[ExecutionPlanner] No fields to fill");
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          success: false,
        };
      }

      // 3. 构建执行计划
      const executionPlan = buildExecutionPlan(schema, normalizationResult.normalized);

      logs.push(`[ExecutionPlanner] Built plan: ${executionPlan.fillPlans.length} fill plans, ${executionPlan.metadata.highConfidenceCount} high confidence`);

      // 4. 保存计划
      const planId = executionPlan.planId;
      // 实际实现应该持久化存储

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
