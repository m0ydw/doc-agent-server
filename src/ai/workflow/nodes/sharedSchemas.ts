/**
 * ================================================================
 * 共享 Zod Schema 和 Normalize 函数
 * ================================================================
 *
 * 解决 ExecutionPlanner 和 DocumentFiller 之间的 schema 不一致问题。
 *
 * 核心问题：
 * - JSON 没有 Map 类型，Map 经过 JSON.stringify 后变成普通 object
 * - Zod 的 z.map() 期望 Map 类型，但接收到的是普通 object
 * - 解决方案：统一使用 z.record()，并在入口处 normalize
 */

import { z } from "zod";

// ================================================================
// 共享 Zod Schema
// ================================================================

/**
 * constraintScores schema
 * 使用 z.record() 而不是 z.map()，因为 JSON 没有 Map 类型
 * 默认值为 {}，允许缺失
 */
export const ConstraintScoresSchema = z
  .record(z.string(), z.number())
  .default({});

/**
 * CandidateTarget schema
 * 共享于 executionPlanner 和 documentFiller
 */
export const CandidateTargetSchema = z.object({
  nodeId: z.string(),
  ref: z.string(),
  tableIndex: z.number().optional(),
  row: z.number(),
  col: z.number(),
  confidence: z.number(),
  reason: z.string(),
  constraintScores: ConstraintScoresSchema,
  copyStyleFromReferenceNodeId: z.string().optional(),
});

/**
 * FillPlan schema
 */
export const FillPlanSchema = z.object({
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

/**
 * ExecutionPlan schema
 */
export const ExecutionPlanSchema = z.object({
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

// ================================================================
// Normalize 函数
// ================================================================

/**
 * 将各种格式的 constraintScores 转换为普通 object
 *
 * 支持的输入格式：
 * - Map<string, number> → Object.fromEntries(map)
 * - Record<string, number> → 保持不变
 * - null/undefined → {}
 * - 其他 → {}
 */
export function normalizeConstraintScores(
  value: unknown
): Record<string, number> {
  if (!value) return {};

  // Map → Object
  if (value instanceof Map) {
    const result: Record<string, number> = {};
    for (const [k, v] of value.entries()) {
      if (typeof v === "number") result[k] = v;
    }
    return result;
  }

  // 普通 object → 过滤非 number 值
  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number") result[k] = v;
    }
    return result;
  }

  return {};
}

/**
 * 将 CandidateTarget 中的 constraintScores 转换为普通 object
 */
export function normalizeCandidateTarget(target: unknown): unknown {
  if (!target || typeof target !== "object") return target;
  const t = target as Record<string, unknown>;
  return {
    ...t,
    constraintScores: normalizeConstraintScores(t.constraintScores),
  };
}

/**
 * 将整个 ExecutionPlan 中的 constraintScores 转换为普通 object
 *
 * 处理路径：
 * - fillPlans[].candidateTargets[].constraintScores
 * - fillPlans[].selectedTarget.constraintScores
 */
export function normalizeExecutionPlan(plan: unknown): unknown {
  if (!plan || typeof plan !== "object") return plan;
  const p = plan as Record<string, unknown>;
  if (!Array.isArray(p.fillPlans)) return plan;

  return {
    ...p,
    fillPlans: (p.fillPlans as unknown[]).map((fp) => {
      if (!fp || typeof fp !== "object") return fp;
      const f = fp as Record<string, unknown>;
      return {
        ...f,
        candidateTargets: Array.isArray(f.candidateTargets)
          ? (f.candidateTargets as unknown[]).map(normalizeCandidateTarget)
          : f.candidateTargets,
        selectedTarget: normalizeCandidateTarget(f.selectedTarget),
      };
    }),
  };
}
