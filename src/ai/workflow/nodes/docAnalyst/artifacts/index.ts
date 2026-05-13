/**
 * ================================================================
 * Analysis Artifacts 入口
 * ================================================================
 *
 * Layer 7: 分析工件管理
 */

import type {
  ParsedDocumentPayload,
  LogicalSpatialGraph,
  ComplexityScore,
  StructuralSummary,
  LayoutUnderstanding,
  SectionUnderstanding,
  FieldUnderstanding,
  AnalysisArtifacts,
} from "../types";
import { v4 as uuidv4 } from "uuid";

/** 工件存储（内存） */
const artifactStore = new Map<string, AnalysisArtifacts>();

/**
 * 保存分析工件
 */
export async function saveArtifacts(artifacts: AnalysisArtifacts): Promise<string> {
  const artifactsId = `artifacts_${uuidv4()}`;
  artifactStore.set(artifactsId, artifacts);
  return artifactsId;
}

/**
 * 获取分析工件
 */
export async function getArtifacts(artifactsId: string): Promise<AnalysisArtifacts | null> {
  return artifactStore.get(artifactsId) || null;
}

/**
 * 删除分析工件
 */
export async function deleteArtifacts(artifactsId: string): Promise<void> {
  artifactStore.delete(artifactsId);
}

/**
 * 构建分析工件
 */
export function buildArtifacts(
  docId: string,
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph,
  complexity: ComplexityScore,
  summary: StructuralSummary,
  layoutUnderstanding: LayoutUnderstanding,
  sectionUnderstandings: SectionUnderstanding[],
  fieldUnderstandings: FieldUnderstanding[],
  fallbackUsed: boolean,
  fallbackReason?: string
): AnalysisArtifacts {
  return {
    docId,
    payload,
    graph,
    complexity,
    summary,
    layoutUnderstanding,
    sectionUnderstandings,
    fieldUnderstandings,
    metadata: {
      analyzedAt: new Date().toISOString(),
      passCount: sectionUnderstandings.length > 0 ? 3 : 2,
      fallbackUsed,
      fallbackReason,
    },
  };
}
