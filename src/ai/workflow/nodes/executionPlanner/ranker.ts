/**
 * ================================================================
 * 排名器
 * ================================================================
 *
 * 根据置信度和约束对候选目标进行排名
 */

import type { CandidateTarget, FillConstraint, SemanticCell } from "./types";
import { evaluateConstraints, calculateConstraintScore } from "./constraintEngine";

/**
 * 排名候选目标
 */
export function rankCandidates(
  candidates: CandidateTarget[],
  constraints: FillConstraint[],
  cellMap?: Map<string, SemanticCell>
): CandidateTarget[] {
  // 为每个候选计算约束分数
  const rankedCandidates = candidates.map(candidate => {
    const cell = cellMap?.get(candidate.nodeId);
    const constraintEvaluations = evaluateConstraints(candidate, constraints, cell);
    const constraintScore = calculateConstraintScore(constraintEvaluations);

    // 更新约束分数
    const constraintScores = new Map<string, number>();
    for (const evaluation of constraintEvaluations) {
      constraintScores.set(evaluation.constraintType, evaluation.score);
    }

    // 综合分数 = 原始置信度 * 0.6 + 约束分数 * 0.4
    const finalScore = candidate.confidence * 0.6 + constraintScore * 0.4;

    return {
      ...candidate,
      constraintScores,
      confidence: finalScore,
    };
  });

  // 按综合分数降序排序
  rankedCandidates.sort((a, b) => b.confidence - a.confidence);

  return rankedCandidates;
}

/**
 * 选择最佳候选
 */
export function selectBestCandidate(
  candidates: CandidateTarget[],
  minConfidence: number = 0.5
): CandidateTarget | undefined {
  if (candidates.length === 0) return undefined;

  const best = candidates[0];
  if (best.confidence < minConfidence) return undefined;

  return best;
}

/**
 * 去重候选（避免同一单元格被多个字段选中）
 */
export function deduplicateCandidates(
  allCandidates: Array<{ fieldId: string; candidates: CandidateTarget[] }>
): Array<{ fieldId: string; candidates: CandidateTarget[]; selected?: CandidateTarget }> {
  const usedNodes = new Set<string>();
  const results: Array<{ fieldId: string; candidates: CandidateTarget[]; selected?: CandidateTarget }> = [];

  // 按置信度排序所有候选
  const sortedFields = [...allCandidates].sort((a, b) => {
    const maxA = a.candidates.length > 0 ? a.candidates[0].confidence : 0;
    const maxB = b.candidates.length > 0 ? b.candidates[0].confidence : 0;
    return maxB - maxA;
  });

  for (const field of sortedFields) {
    // 过滤掉已使用的节点
    const availableCandidates = field.candidates.filter(
      c => !usedNodes.has(c.nodeId)
    );

    // 选择最佳候选
    const selected = availableCandidates.length > 0 ? availableCandidates[0] : undefined;

    if (selected) {
      usedNodes.add(selected.nodeId);
    }

    results.push({
      fieldId: field.fieldId,
      candidates: availableCandidates,
      selected,
    });
  }

  return results;
}
