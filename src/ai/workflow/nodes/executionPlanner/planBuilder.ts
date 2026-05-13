/**
 * ================================================================
 * 计划构建器
 * ================================================================
 *
 * 构建 FillPlan 和 ExecutionPlan
 */

import { v4 as uuidv4 } from "uuid";
import type {
  SemanticDocumentSchema,
  NormalizedUserData,
  FillPlan,
  ExecutionPlan,
  FillConstraint,
  CandidateTarget,
  MatchResult,
} from "./types";
import { matchUserDataToCells } from "./matcher";
import { rankCandidates, selectBestCandidate, deduplicateCandidates } from "./ranker";

/** 默认约束 */
const DEFAULT_CONSTRAINTS: FillConstraint[] = [
  { type: "avoid_readonly", weight: 0.8 },
  { type: "single_target", weight: 0.6 },
];

/**
 * 构建执行计划
 */
export function buildExecutionPlan(
  schema: SemanticDocumentSchema,
  normalizedData: NormalizedUserData
): ExecutionPlan {
  // 1. 匹配用户数据到可写单元格
  const matchResults = matchUserDataToCells(schema, normalizedData);

  // 2. 为每个匹配结果排名候选
  const rankedResults = matchResults.map(match => ({
    fieldId: match.fieldId,
    candidates: rankCandidates(match.candidates, DEFAULT_CONSTRAINTS),
  }));

  // 3. 去重（避免同一单元格被多个字段选中）
  const deduplicatedResults = deduplicateCandidates(rankedResults);

  // 4. 构建 FillPlan
  const fillPlans: FillPlan[] = deduplicatedResults.map(result => ({
    fieldId: result.fieldId,
    semanticMeaning: normalizedData[result.fieldId]?.value || "",
    candidateTargets: result.candidates,
    selectedTarget: result.selected,
    confidence: result.selected?.confidence || 0,
    constraints: DEFAULT_CONSTRAINTS,
    sectionContext: inferSectionContext(result.selected, schema),
  }));

  // 5. 统计
  const highConfidenceCount = fillPlans.filter(p => p.confidence >= 0.7).length;

  return {
    planId: `plan_${uuidv4()}`,
    docId: schema.docId,
    schemaId: schema.schemaId,
    fillPlans,
    metadata: {
      totalFields: fillPlans.length,
      highConfidenceCount,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * 推断区域上下文
 */
function inferSectionContext(
  candidate: CandidateTarget | undefined,
  schema: SemanticDocumentSchema
): string {
  if (!candidate) return "";

  // 查找候选所在的区域
  for (const section of schema.sections) {
    const isInSection = section.cells.some(c => c.id === candidate.nodeId);
    if (isInSection) {
      return section.semanticMeaning || section.name;
    }
  }

  return "";
}
