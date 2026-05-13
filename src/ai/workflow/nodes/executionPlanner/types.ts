/**
 * ================================================================
 * Execution Planner 类型定义
 * ================================================================
 */

import type {
  SemanticDocumentSchema,
  NormalizedUserData,
  FillPlan,
  ExecutionPlan,
  FillConstraint,
  CandidateTarget,
  SemanticCell,
} from "../docAnalyst/types";

export type {
  SemanticDocumentSchema,
  NormalizedUserData,
  FillPlan,
  ExecutionPlan,
  FillConstraint,
  CandidateTarget,
  SemanticCell,
};

/** 用户数据归一化结果 */
export interface NormalizationResult {
  normalized: NormalizedUserData;
  matchCount: number;
  totalCount: number;
}

/** 匹配结果 */
export interface MatchResult {
  fieldId: string;
  semanticMeaning: string;
  candidates: CandidateTarget[];
  bestCandidate?: CandidateTarget;
  confidence: number;
}

/** 约束评分 */
export interface ConstraintScore {
  constraintType: string;
  score: number;
  reason: string;
}
