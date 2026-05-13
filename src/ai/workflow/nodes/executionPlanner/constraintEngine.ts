/**
 * ================================================================
 * 约束引擎
 * ================================================================
 *
 * 根据约束条件评估候选目标
 */

import type { FillConstraint, CandidateTarget, SemanticCell } from "./types";

/** 约束评估结果 */
export interface ConstraintEvaluation {
  constraintType: string;
  score: number;
  reason: string;
  passed: boolean;
}

/**
 * 评估约束
 */
export function evaluateConstraints(
  candidate: CandidateTarget,
  constraints: FillConstraint[],
  cell?: SemanticCell
): ConstraintEvaluation[] {
  return constraints.map(constraint => evaluateSingleConstraint(candidate, constraint, cell));
}

/**
 * 评估单个约束
 */
function evaluateSingleConstraint(
  candidate: CandidateTarget,
  constraint: FillConstraint,
  cell?: SemanticCell
): ConstraintEvaluation {
  switch (constraint.type) {
    case "single_target":
      return evaluateSingleTarget(candidate, constraint);
    case "avoid_readonly":
      return evaluateAvoidReadonly(candidate, constraint, cell);
    case "prefer_multiline":
      return evaluatePreferMultiline(candidate, constraint, cell);
    case "prefer_repeated_section":
      return evaluatePreferRepeatedSection(candidate, constraint, cell);
    default:
      return {
        constraintType: constraint.type,
        score: 0.5,
        reason: "未知约束类型",
        passed: true,
      };
  }
}

/**
 * 评估单目标约束
 */
function evaluateSingleTarget(
  candidate: CandidateTarget,
  constraint: FillConstraint
): ConstraintEvaluation {
  // 单目标约束：只有一个候选时得分最高
  const score = 1.0;

  return {
    constraintType: "single_target",
    score: score * constraint.weight,
    reason: "单目标约束",
    passed: true,
  };
}

/**
 * 评估避免只读约束
 */
function evaluateAvoidReadonly(
  candidate: CandidateTarget,
  constraint: FillConstraint,
  cell?: SemanticCell
): ConstraintEvaluation {
  if (!cell) {
    return {
      constraintType: "avoid_readonly",
      score: 0.5,
      reason: "无法确定单元格状态",
      passed: true,
    };
  }

  const isReadonly = cell.role === "readonly" || cell.role === "static_text";
  const score = isReadonly ? 0 : 1;

  return {
    constraintType: "avoid_readonly",
    score: score * constraint.weight,
    reason: isReadonly ? "单元格为只读" : "单元格可写",
    passed: !isReadonly,
  };
}

/**
 * 评估偏好多行约束
 */
function evaluatePreferMultiline(
  candidate: CandidateTarget,
  constraint: FillConstraint,
  cell?: SemanticCell
): ConstraintEvaluation {
  if (!cell) {
    return {
      constraintType: "prefer_multiline",
      score: 0.5,
      reason: "无法确定单元格属性",
      passed: true,
    };
  }

  // 检查是否是多行区域（简单实现）
  const isMultiline = cell.text && cell.text.length > 50;
  const score = isMultiline ? 1 : 0.5;

  return {
    constraintType: "prefer_multiline",
    score: score * constraint.weight,
    reason: isMultiline ? "多行区域" : "单行区域",
    passed: true,
  };
}

/**
 * 评估偏好重复区域约束
 */
function evaluatePreferRepeatedSection(
  candidate: CandidateTarget,
  constraint: FillConstraint,
  cell?: SemanticCell
): ConstraintEvaluation {
  if (!cell) {
    return {
      constraintType: "prefer_repeated_section",
      score: 0.5,
      reason: "无法确定区域属性",
      passed: true,
    };
  }

  // 检查是否在重复区域（简化实现）
  const isInRepeatedSection = false; // 实际实现需要检查 repeatedPatterns
  const score = isInRepeatedSection ? 1 : 0.5;

  return {
    constraintType: "prefer_repeated_section",
    score: score * constraint.weight,
    reason: isInRepeatedSection ? "在重复区域" : "不在重复区域",
    passed: true,
  };
}

/**
 * 计算综合约束分数
 */
export function calculateConstraintScore(evaluations: ConstraintEvaluation[]): number {
  if (evaluations.length === 0) return 1;

  const totalWeight = evaluations.reduce((sum, e) => sum + e.score, 0);
  return totalWeight / evaluations.length;
}
