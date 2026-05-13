/**
 * ================================================================
 * Writable Region Detection 入口
 * ================================================================
 *
 * Layer 6: 可写区域检测
 */

import type {
  FieldUnderstanding,
  LogicalSpatialGraph,
  ParsedDocumentPayload,
  SemanticCell,
  CellNeighborhood,
  WritableConfidence,
  RepeatedWritablePattern,
  CellRole,
  SemanticType,
  AnalysisTrace,
  TraceLevel,
} from "../types";
import { parseCellNodeId } from "../types";

/**
 * 检测可写区域
 */
export function detectWritableRegions(
  fieldUnderstandings: FieldUnderstanding[],
  graph: LogicalSpatialGraph,
  payload: ParsedDocumentPayload,
  traceLevel: TraceLevel = "minimal"
): {
  semanticCells: SemanticCell[];
  writableCells: SemanticCell[];
  repeatedPatterns: RepeatedWritablePattern[];
  traces: Map<string, AnalysisTrace>;
} {
  const traces = new Map<string, AnalysisTrace>();

  // 构建语义单元格
  const semanticCells = fieldUnderstandings.map(fu => {
    const neighborhood = graph.neighborhoods.get(fu.nodeId) || createEmptyNeighborhood(fu.nodeId);
    const writableConfidence = calculateWritableConfidence(fu, neighborhood, graph);
    const trace = buildTrace(fu, traceLevel);

    traces.set(fu.nodeId, trace);

    return {
      id: fu.nodeId,
      ref: extractRefFromNodeId(fu.nodeId, payload),
      tableIndex: extractTableIndexFromNodeId(fu.nodeId),
      row: extractRowFromNodeId(fu.nodeId),
      col: extractColFromNodeId(fu.nodeId),
      text: extractTextFromNodeId(fu.nodeId, payload),
      role: fu.role,
      semanticType: fu.semanticType,
      writableConfidence,
      neighborhood,
      traceId: fu.nodeId,
    };
  });

  // 筛选可写单元格
  const writableCells = semanticCells.filter(
    c => c.role === "empty_fillable" || c.role === "fillable_with_placeholder"
  );

  // 检测重复可写模式
  const repeatedPatterns = detectRepeatedWritablePatterns(semanticCells, graph);

  return {
    semanticCells,
    writableCells,
    repeatedPatterns,
    traces,
  };
}

/**
 * 计算可写置信度
 */
function calculateWritableConfidence(
  fieldUnderstanding: FieldUnderstanding,
  neighborhood: CellNeighborhood,
  graph: LogicalSpatialGraph
): WritableConfidence {
  // 结构置信度：基于邻域关系
  const structuralConfidence = calculateStructuralConfidence(fieldUnderstanding, neighborhood);

  // 语义置信度：基于语义分析
  const semanticConfidence = calculateSemanticConfidence(fieldUnderstanding);

  // 模式置信度：基于重复模式
  const patternConfidence = calculatePatternConfidence(fieldUnderstanding, graph);

  // 最终置信度：加权平均
  const finalConfidence = (
    structuralConfidence * 0.4 +
    semanticConfidence * 0.4 +
    patternConfidence * 0.2
  );

  const factors: string[] = [];
  if (structuralConfidence > 0.7) factors.push("strong_structural");
  if (semanticConfidence > 0.7) factors.push("strong_semantic");
  if (patternConfidence > 0.7) factors.push("strong_pattern");

  return {
    structuralConfidence,
    semanticConfidence,
    patternConfidence,
    finalConfidence,
    factors,
  };
}

/**
 * 计算结构置信度
 */
function calculateStructuralConfidence(
  fieldUnderstanding: FieldUnderstanding,
  neighborhood: CellNeighborhood
): number {
  let confidence = 0.3; // 基础置信度

  // 有标签邻居增加置信度
  if (neighborhood.left || neighborhood.top) {
    confidence += 0.2;
  }

  // 空单元格增加置信度
  if (fieldUnderstanding.role === "empty_fillable") {
    confidence += 0.2;
  }

  // 有占位符增加置信度
  if (fieldUnderstanding.role === "fillable_with_placeholder") {
    confidence += 0.3;
  }

  return Math.min(confidence, 1);
}

/**
 * 计算语义置信度
 */
function calculateSemanticConfidence(fieldUnderstanding: FieldUnderstanding): number {
  // 直接使用 LLM 给出的置信度
  return fieldUnderstanding.confidence;
}

/**
 * 计算模式置信度
 */
function calculatePatternConfidence(
  fieldUnderstanding: FieldUnderstanding,
  graph: LogicalSpatialGraph
): number {
  // 检查是否在重复模式中
  for (const pattern of graph.repeatedPatterns) {
    for (const occurrence of pattern.nodeIds) {
      if (occurrence.includes(fieldUnderstanding.nodeId)) {
        return 0.8;
      }
    }
  }

  return 0.3;
}

/**
 * 检测重复可写模式
 */
function detectRepeatedWritablePatterns(
  semanticCells: SemanticCell[],
  graph: LogicalSpatialGraph
): RepeatedWritablePattern[] {
  const patterns: RepeatedWritablePattern[] = [];

  // 分析重复模式
  for (const pattern of graph.repeatedPatterns) {
    const writableNodes: string[] = [];

    for (const occurrence of pattern.nodeIds) {
      for (const nodeId of occurrence) {
        const cell = semanticCells.find(c => c.id === nodeId);
        if (cell && (cell.role === "empty_fillable" || cell.role === "fillable_with_placeholder")) {
          writableNodes.push(nodeId);
        }
      }
    }

    if (writableNodes.length > 0) {
      patterns.push({
        patternId: `pattern_${patterns.length}`,
        templateNodes: pattern.nodeIds[0] || [],
        repeatedRows: pattern.occurrences,
        semanticMeaning: inferPatternMeaning(semanticCells, pattern.nodeIds[0] || []),
        writableNodes,
      });
    }
  }

  return patterns;
}

/**
 * 推断模式含义
 */
function inferPatternMeaning(semanticCells: SemanticCell[], templateNodes: string[]): string {
  // 查找模板中的标签
  const labels = templateNodes
    .map(nodeId => semanticCells.find(c => c.id === nodeId))
    .filter(c => c && c.role === "label")
    .map(c => c!.text);

  if (labels.length > 0) {
    return `重复字段组：${labels.join(", ")}`;
  }

  return "重复结构";
}

/**
 * 构建分析追踪
 */
function buildTrace(
  fieldUnderstanding: FieldUnderstanding,
  traceLevel: TraceLevel
): AnalysisTrace {
  if (traceLevel === "none") {
    return { level: traceLevel, steps: [] };
  }

  const steps: AnalysisTrace["steps"] = [];

  // minimal 模式：只保留关键决策
  steps.push({
    step: "role_classification",
    reasoning: fieldUnderstanding.spatialReason,
    confidence: fieldUnderstanding.confidence,
    timestamp: new Date().toISOString(),
  });

  if (traceLevel === "debug") {
    // debug 模式：保留完整信息
    steps.push({
      step: "semantic_analysis",
      reasoning: fieldUnderstanding.semanticReason,
      confidence: fieldUnderstanding.confidence,
      timestamp: new Date().toISOString(),
      input: fieldUnderstanding.semanticType,
    });
  }

  return { level: traceLevel, steps };
}

/**
 * 从 nodeId 提取 ref
 */
function extractRefFromNodeId(nodeId: string, payload: ParsedDocumentPayload): string {
  const parsed = parseCellNodeId(nodeId);
  if (!parsed) return "";

  const table = payload.tables.find(t => t.index === parsed.tableIndex);
  if (!table) return "";

  const cell = table.cells.find(c => c.row === parsed.row && c.col === parsed.col);
  return cell?.ref || "";
}

function extractTableIndexFromNodeId(nodeId: string): number {
  return parseCellNodeId(nodeId)?.tableIndex ?? 0;
}

/**
 * 从 nodeId 提取 row
 */
function extractRowFromNodeId(nodeId: string): number {
  return parseCellNodeId(nodeId)?.row ?? 0;
}

/**
 * 从 nodeId 提取 col
 */
function extractColFromNodeId(nodeId: string): number {
  return parseCellNodeId(nodeId)?.col ?? 0;
}

/**
 * 从 nodeId 提取 text
 */
function extractTextFromNodeId(nodeId: string, payload: ParsedDocumentPayload): string {
  const parsed = parseCellNodeId(nodeId);
  if (!parsed) return "";

  const table = payload.tables.find(t => t.index === parsed.tableIndex);
  if (!table) return "";

  const cell = table.cells.find(c => c.row === parsed.row && c.col === parsed.col);
  return cell?.text || "";
}

/**
 * 创建空邻域
 */
function createEmptyNeighborhood(nodeId: string): CellNeighborhood {
  return {
    nodeId,
    nearby: [],
  };
}
