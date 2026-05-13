/**
 * ================================================================
 * Schema 入口
 * ================================================================
 *
 * Layer 8: Semantic Document Schema 管理
 */

import { v4 as uuidv4 } from "uuid";
import type {
  AnalysisArtifacts,
  SemanticDocumentSchema,
  SemanticCell,
  SemanticSection,
  SectionUnderstanding,
  TraceLevel,
} from "../types";
import { detectWritableRegions } from "../writable";

/** Schema 存储（内存） */
const schemaStore = new Map<string, SemanticDocumentSchema>();

/** Trace 存储（内存） */
const traceStore = new Map<string, unknown>();

/**
 * 保存 Schema
 */
export async function saveSchema(schema: SemanticDocumentSchema): Promise<string> {
  schemaStore.set(schema.schemaId, schema);
  return schema.schemaId;
}

/**
 * 获取 Schema
 */
export async function getSchema(schemaId: string): Promise<SemanticDocumentSchema | null> {
  return schemaStore.get(schemaId) || null;
}

/**
 * 删除 Schema
 */
export async function deleteSchema(schemaId: string): Promise<void> {
  schemaStore.delete(schemaId);
}

/**
 * 从 Artifacts 构建 Schema
 */
export function buildSemanticSchema(
  artifacts: AnalysisArtifacts,
  traceLevel: TraceLevel = "minimal"
): SemanticDocumentSchema {
  const {
    docId,
    graph,
    complexity,
    fieldUnderstandings,
    layoutUnderstanding,
    sectionUnderstandings,
  } = artifacts;

  // 检测可写区域
  const { semanticCells, writableCells, repeatedPatterns, traces } =
    detectWritableRegions(fieldUnderstandings, graph, artifacts.payload, traceLevel);

  // 存储 traces
  for (const [id, trace] of traces) {
    traceStore.set(id, trace);
  }

  // 构建语义区域
  const sections = buildSemanticSections(
    graph.sections,
    semanticCells,
    sectionUnderstandings
  );

  // 计算整体置信度
  const overallConfidence = calculateOverallConfidence(semanticCells);

  return {
    schemaId: `schema_${uuidv4()}`,
    docId,
    layoutType: layoutUnderstanding.tableType,
    analysisMode: complexity.mode,
    sections,
    allCells: semanticCells,
    writableCells,
    repeatedPatterns,
    metadata: {
      analyzedAt: new Date().toISOString(),
      passCount: sectionUnderstandings.length > 0 ? 3 : 2,
      overallConfidence,
      traceLevel,
    },
  };
}

/**
 * 构建语义区域
 */
function buildSemanticSections(
  sections: AnalysisArtifacts["graph"]["sections"],
  semanticCells: SemanticCell[],
  sectionUnderstandings: SectionUnderstanding[]
): SemanticSection[] {
  return sections.map(section => {
    const sectionCells = semanticCells.filter(
      c => c.tableIndex === section.tableIndex &&
        c.row >= section.startRow &&
        c.row <= section.endRow
    );
    const writableCells = sectionCells.filter(
      c => c.role === "empty_fillable" || c.role === "fillable_with_placeholder"
    );

    // 查找对应的 SectionUnderstanding
    const understanding = sectionUnderstandings.find(
      su => su.sectionId === section.id
    );

    return {
      id: section.id,
      name: understanding?.semanticMeaning || `Section ${section.id}`,
      cells: sectionCells,
      writableCells,
      semanticMeaning: understanding?.semanticMeaning || "",
      confidence: section.confidence,
      boundaryType: section.boundaryType,
    };
  });
}

/**
 * 计算整体置信度
 */
function calculateOverallConfidence(semanticCells: SemanticCell[]): number {
  if (semanticCells.length === 0) return 0;

  const totalConfidence = semanticCells.reduce(
    (sum, cell) => sum + cell.writableConfidence.finalConfidence, 0
  );

  return totalConfidence / semanticCells.length;
}

/**
 * 获取 Trace
 */
export function getTrace(traceId: string): unknown {
  return traceStore.get(traceId);
}
