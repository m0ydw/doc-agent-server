import { ChatOpenAI } from "@langchain/openai";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../../state";
import type { ExecutionPlan, NormalizedUserData } from "./types";
import { normalizeUserData } from "./normalizer";
import { buildExecutionPlan } from "./planBuilder";
import { getSchema } from "../docAnalyst/schema";
import { getTableFillAnalysis } from "../tableFill/store";
import { buildLayoutBasedExecutionPlan } from "../tableFill/planner";
import { ExecutionPlanSchema, normalizeExecutionPlan } from "../sharedSchemas";

function failedPlannerPatch(
  state: typeof AgentState.State,
  logs: string[],
  message: string,
  plan?: ExecutionPlan,
): Partial<typeof AgentState.State> {
  return {
    executionPlanId: plan?.planId || "",
    executionPlan: plan ? JSON.stringify(normalizeExecutionPlan(plan)) : state.executionPlan,
    executionLog: logs.join("\n"),
    delegationStep: (state.delegationStep ?? 0) + 1,
    lastAgent: "ExecutionPlanner",
    executionPlannerStatus: "failed",
    success: false,
    retryable: false,
    workflowError: message,
  };
}

function hasExecutablePlans(plan: ExecutionPlan): boolean {
  return Array.isArray(plan.fillPlans)
    && plan.fillPlans.some(fillPlan => fillPlan.selectedTarget && fillPlan.confidence >= 0.5);
}

function validatePlanOrFail(plan: ExecutionPlan): string | null {
  if (!Array.isArray(plan.fillPlans) || plan.fillPlans.length === 0) {
    return "执行规划失败：没有生成任何 targetNodeId/ref 级写入动作。";
  }
  if (!hasExecutablePlans(plan)) {
    return "执行规划失败：没有可执行的写入动作（所有目标置信度过低或缺失）。";
  }
  const normalized = normalizeExecutionPlan(plan);
  const validated = ExecutionPlanSchema.safeParse(normalized);
  if (!validated.success) {
    return "执行计划结构校验失败，未生成可交给 DocumentFiller 的合法计划。";
  }
  return null;
}

export function createExecutionPlannerNode(_llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
    const logs: string[] = [];

    try {
      logs.push("[ExecutionPlanner] Starting execution planning...");

      if (state.tableAnalysisId) {
        const analysis = getTableFillAnalysis(state.tableAnalysisId);
        if (!analysis) {
          logs.push(`[ExecutionPlanner] Table analysis not found: ${state.tableAnalysisId}`);
          return failedPlannerPatch(state, logs, "表格分析结果不存在，无法生成写入计划。");
        }

        const { plan, stats } = buildLayoutBasedExecutionPlan(analysis);
        logs.push(`[ExecutionPlanner] Layout plan: recognized=${stats.recognizedFields}, mapped=${stats.mappedFields}, lowConfidence=${stats.lowConfidenceCount}`);
        if (stats.failedReasons.length > 0) {
          logs.push(`[ExecutionPlanner] Failed reasons: ${stats.failedReasons.join("; ")}`);
        }

        const failure = validatePlanOrFail(plan);
        if (failure) {
          return failedPlannerPatch(state, logs, failure, plan);
        }

        return {
          executionPlanId: plan.planId,
          executionPlan: JSON.stringify(normalizeExecutionPlan(plan)),
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "ExecutionPlanner",
          executionPlannerStatus: "success",
          success: true,
          workflowError: "",
        };
      }

      const schemaId = state.semanticSchemaId;
      if (!schemaId) {
        logs.push("[ExecutionPlanner] No schema ID found");
        return failedPlannerPatch(state, logs, "执行规划失败：缺少语义 schema。");
      }

      const schema = await getSchema(schemaId);
      if (!schema) {
        logs.push(`[ExecutionPlanner] Schema not found: ${schemaId}`);
        return failedPlannerPatch(state, logs, "执行规划失败：语义 schema 不存在。");
      }

      let extractedData: Record<string, unknown>;
      try {
        extractedData = JSON.parse(state.extractedData || "{}");
      } catch (err) {
        logs.push(`[ExecutionPlanner] Failed to parse extractedData JSON: ${(err as Error).message}`);
        return failedPlannerPatch(state, logs, "用户数据 JSON 解析失败。");
      }

      const normalizationResult = normalizeUserData(extractedData);
      logs.push(`[ExecutionPlanner] Normalized data: ${normalizationResult.matchCount}/${normalizationResult.totalCount} fields`);

      if (normalizationResult.matchCount === 0) {
        return failedPlannerPatch(state, logs, "执行规划失败：没有可填充的字段。");
      }

      const executionPlan = buildExecutionPlan(schema, normalizationResult.normalized);
      logs.push(`[ExecutionPlanner] Built plan: ${executionPlan.fillPlans.length} fill plans, ${executionPlan.metadata.highConfidenceCount} high confidence`);

      const failure = validatePlanOrFail(executionPlan);
      if (failure) {
        return failedPlannerPatch(state, logs, failure, executionPlan);
      }

      return {
        executionPlanId: executionPlan.planId,
        executionPlan: JSON.stringify(normalizeExecutionPlan(executionPlan)),
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "ExecutionPlanner",
        executionPlannerStatus: "success",
        success: true,
        workflowError: "",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logs.push(`[ExecutionPlanner] Error: ${msg}`);
      console.error("[ExecutionPlanner] Error:", err);
      return failedPlannerPatch(state, logs, `执行规划异常：${msg}`);
    }
  };
}

export type {
  ExecutionPlan,
  FillPlan,
  CandidateTarget,
  NormalizedUserData,
} from "./types";
