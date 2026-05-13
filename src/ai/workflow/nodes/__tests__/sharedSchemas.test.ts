/**
 * ================================================================
 * 共享 Zod Schema 和 Normalize 函数的单元测试
 * ================================================================
 */

import { describe, it, expect } from "vitest";
import {
  ConstraintScoresSchema,
  CandidateTargetSchema,
  FillPlanSchema,
  ExecutionPlanSchema,
  normalizeConstraintScores,
  normalizeCandidateTarget,
  normalizeExecutionPlan,
} from "../sharedSchemas";

// ================================================================
// ConstraintScoresSchema 测试
// ================================================================

describe("ConstraintScoresSchema", () => {
  it("普通 object 应成功", () => {
    const result = ConstraintScoresSchema.safeParse({ layout_position: 0.96 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ layout_position: 0.96 });
    }
  });

  it("缺失时默认 {}", () => {
    const result = ConstraintScoresSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it("空 object 应成功", () => {
    const result = ConstraintScoresSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it("多个键值对应成功", () => {
    const input = {
      layout_position: 0.96,
      same_table: 1,
      same_row: 0.8,
    };
    const result = ConstraintScoresSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it("null 应失败（因为 default 只处理 undefined）", () => {
    const result = ConstraintScoresSchema.safeParse(null);
    // z.record 不接受 null，但 .default({}) 只对 undefined 生效
    // 所以 null 会失败
    expect(result.success).toBe(false);
  });
});

// ================================================================
// normalizeConstraintScores 测试
// ================================================================

describe("normalizeConstraintScores", () => {
  it("null 返回 {}", () => {
    expect(normalizeConstraintScores(null)).toEqual({});
  });

  it("undefined 返回 {}", () => {
    expect(normalizeConstraintScores(undefined)).toEqual({});
  });

  it("Map 转换为普通 object", () => {
    const map = new Map([["layout_position", 0.96]]);
    expect(normalizeConstraintScores(map)).toEqual({ layout_position: 0.96 });
  });

  it("多键 Map 转换为普通 object", () => {
    const map = new Map([
      ["layout_position", 0.96],
      ["same_table", 1],
      ["same_row", 0.8],
    ]);
    expect(normalizeConstraintScores(map)).toEqual({
      layout_position: 0.96,
      same_table: 1,
      same_row: 0.8,
    });
  });

  it("普通 object 保持不变", () => {
    const obj = { layout_position: 0.96 };
    expect(normalizeConstraintScores(obj)).toEqual(obj);
  });

  it("过滤非 number 值", () => {
    const obj = { layout_position: 0.96, invalid: "string", also_invalid: null };
    expect(normalizeConstraintScores(obj)).toEqual({ layout_position: 0.96 });
  });

  it("数组返回 {}", () => {
    expect(normalizeConstraintScores([1, 2, 3])).toEqual({});
  });

  it("字符串返回 {}", () => {
    expect(normalizeConstraintScores("invalid")).toEqual({});
  });
});

// ================================================================
// normalizeCandidateTarget 测试
// ================================================================

describe("normalizeCandidateTarget", () => {
  it("null 返回 null", () => {
    expect(normalizeCandidateTarget(null)).toBeNull();
  });

  it("undefined 返回 undefined", () => {
    expect(normalizeCandidateTarget(undefined)).toBeUndefined();
  });

  it("普通 object 保持不变", () => {
    const target = {
      nodeId: "node_1",
      ref: "A1",
      row: 0,
      col: 0,
      confidence: 0.9,
      reason: "test",
      constraintScores: { layout_position: 0.9 },
    };
    expect(normalizeCandidateTarget(target)).toEqual(target);
  });

  it("Map constraintScores 转换为普通 object", () => {
    const target = {
      nodeId: "node_1",
      ref: "A1",
      row: 0,
      col: 0,
      confidence: 0.9,
      reason: "test",
      constraintScores: new Map([["layout_position", 0.9]]),
    };
    const expected = {
      nodeId: "node_1",
      ref: "A1",
      row: 0,
      col: 0,
      confidence: 0.9,
      reason: "test",
      constraintScores: { layout_position: 0.9 },
    };
    expect(normalizeCandidateTarget(target)).toEqual(expected);
  });

  it("缺失 constraintScores 默认 {}", () => {
    const target = {
      nodeId: "node_1",
      ref: "A1",
      row: 0,
      col: 0,
      confidence: 0.9,
      reason: "test",
    };
    const result = normalizeCandidateTarget(target) as Record<string, unknown>;
    expect(result.constraintScores).toEqual({});
  });
});

// ================================================================
// normalizeExecutionPlan 测试
// ================================================================

describe("normalizeExecutionPlan", () => {
  it("null 返回 null", () => {
    expect(normalizeExecutionPlan(null)).toBeNull();
  });

  it("undefined 返回 undefined", () => {
    expect(normalizeExecutionPlan(undefined)).toBeUndefined();
  });

  it("没有 fillPlans 的对象保持不变", () => {
    const plan = { planId: "test", docId: "test" };
    expect(normalizeExecutionPlan(plan)).toEqual(plan);
  });

  it("fillPlans 中的 constraintScores 被 normalize", () => {
    const plan = {
      planId: "test",
      docId: "test",
      schemaId: "test",
      fillPlans: [
        {
          fieldId: "field_1",
          semanticMeaning: "value_1",
          candidateTargets: [
            {
              nodeId: "node_1",
              ref: "A1",
              row: 0,
              col: 0,
              confidence: 0.9,
              reason: "test",
              constraintScores: new Map([["layout_position", 0.9]]),
            },
          ],
          selectedTarget: {
            nodeId: "node_1",
            ref: "A1",
            row: 0,
            col: 0,
            confidence: 0.9,
            reason: "test",
            constraintScores: new Map([["layout_position", 0.9]]),
          },
          confidence: 0.9,
          constraints: [{ type: "single_target" as const, weight: 1 }],
          sectionContext: "test",
        },
      ],
      metadata: {
        totalFields: 1,
        highConfidenceCount: 1,
        generatedAt: new Date().toISOString(),
      },
    };

    const result = normalizeExecutionPlan(plan) as Record<string, unknown>;
    const fillPlans = result.fillPlans as Array<Record<string, unknown>>;
    const candidateTargets = fillPlans[0].candidateTargets as Array<Record<string, unknown>>;
    const selectedTarget = fillPlans[0].selectedTarget as Record<string, unknown>;

    expect(candidateTargets[0].constraintScores).toEqual({ layout_position: 0.9 });
    expect(selectedTarget.constraintScores).toEqual({ layout_position: 0.9 });
  });

  it("31 个 fillPlans 都能正确 normalize", () => {
    const plan = {
      planId: "test",
      docId: "test",
      schemaId: "test",
      fillPlans: Array.from({ length: 31 }, (_, i) => ({
        fieldId: `field_${i}`,
        semanticMeaning: `value_${i}`,
        candidateTargets: [
          {
            nodeId: `node_${i}`,
            ref: `ref_${i}`,
            row: i,
            col: 0,
            confidence: 0.9,
            reason: "test",
            constraintScores: { layout_position: 0.9 },
          },
        ],
        selectedTarget: {
          nodeId: `node_${i}`,
          ref: `ref_${i}`,
          row: i,
          col: 0,
          confidence: 0.9,
          reason: "test",
          constraintScores: { layout_position: 0.9 },
        },
        confidence: 0.9,
        constraints: [{ type: "single_target" as const, weight: 1 }],
        sectionContext: "test",
      })),
      metadata: {
        totalFields: 31,
        highConfidenceCount: 31,
        generatedAt: new Date().toISOString(),
      },
    };

    const result = normalizeExecutionPlan(plan);
    expect(result).toBeDefined();

    // 验证可以通过 Zod schema 校验
    const validated = ExecutionPlanSchema.safeParse(result);
    expect(validated.success).toBe(true);
  });
});

// ================================================================
// CandidateTargetSchema 测试
// ================================================================

describe("CandidateTargetSchema", () => {
  it("普通 object 应成功", () => {
    const target = {
      nodeId: "node_1",
      ref: "A1",
      row: 0,
      col: 0,
      confidence: 0.9,
      reason: "test",
      constraintScores: { layout_position: 0.9 },
    };
    const result = CandidateTargetSchema.safeParse(target);
    expect(result.success).toBe(true);
  });

  it("缺失 constraintScores 默认 {}", () => {
    const target = {
      nodeId: "node_1",
      ref: "A1",
      row: 0,
      col: 0,
      confidence: 0.9,
      reason: "test",
    };
    const result = CandidateTargetSchema.safeParse(target);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.constraintScores).toEqual({});
    }
  });

  it("Map 类型应失败", () => {
    const target = {
      nodeId: "node_1",
      ref: "A1",
      row: 0,
      col: 0,
      confidence: 0.9,
      reason: "test",
      constraintScores: new Map([["layout_position", 0.9]]),
    };
    const result = CandidateTargetSchema.safeParse(target);
    expect(result.success).toBe(false);
  });
});

// ================================================================
// ExecutionPlanSchema 测试
// ================================================================

describe("ExecutionPlanSchema", () => {
  it("完整的 ExecutionPlan 应成功", () => {
    const plan = {
      planId: "test",
      docId: "test",
      schemaId: "test",
      fillPlans: [
        {
          fieldId: "field_1",
          semanticMeaning: "value_1",
          candidateTargets: [
            {
              nodeId: "node_1",
              ref: "A1",
              row: 0,
              col: 0,
              confidence: 0.9,
              reason: "test",
              constraintScores: { layout_position: 0.9 },
            },
          ],
          selectedTarget: {
            nodeId: "node_1",
            ref: "A1",
            row: 0,
            col: 0,
            confidence: 0.9,
            reason: "test",
            constraintScores: { layout_position: 0.9 },
          },
          confidence: 0.9,
          constraints: [{ type: "single_target", weight: 1 }],
          sectionContext: "test",
        },
      ],
      metadata: {
        totalFields: 1,
        highConfidenceCount: 1,
        generatedAt: new Date().toISOString(),
      },
    };

    const result = ExecutionPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("constraintScores 为 Map 时应失败", () => {
    const plan = {
      planId: "test",
      docId: "test",
      schemaId: "test",
      fillPlans: [
        {
          fieldId: "field_1",
          semanticMeaning: "value_1",
          candidateTargets: [
            {
              nodeId: "node_1",
              ref: "A1",
              row: 0,
              col: 0,
              confidence: 0.9,
              reason: "test",
              constraintScores: new Map([["layout_position", 0.9]]),
            },
          ],
          selectedTarget: {
            nodeId: "node_1",
            ref: "A1",
            row: 0,
            col: 0,
            confidence: 0.9,
            reason: "test",
            constraintScores: new Map([["layout_position", 0.9]]),
          },
          confidence: 0.9,
          constraints: [{ type: "single_target", weight: 1 }],
          sectionContext: "test",
        },
      ],
      metadata: {
        totalFields: 1,
        highConfidenceCount: 1,
        generatedAt: new Date().toISOString(),
      },
    };

    const result = ExecutionPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});
