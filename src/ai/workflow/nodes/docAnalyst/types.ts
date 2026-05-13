/**
 * ================================================================
 * Semantic Document Runtime - 核心类型定义
 * ================================================================
 *
 * 设计原则：
 * - SemanticDocumentSchema 是唯一真相源
 * - CellRole 是系统核心
 * - 不依赖坐标推断，只使用逻辑空间关系
 * - 所有类型严格分层
 */

import { z } from "zod";

// ================================================================
// Layer 1: Document Parser
// ================================================================

/** 原始单元格 */
export interface RawCell {
  tableIndex: number;
  row: number;
  col: number;
  ref: string;
  text: string;
  rowspan: number;
  colspan: number;
  nodeId: string;
}

/** 原始表格 */
export interface RawTable {
  index: number;
  rows: number;
  cols: number;
  cells: RawCell[];
}

/** 文本提取结果 */
export interface TextExtractionResult {
  refTextMap: Map<string, string>;
  nodeRefMap: Map<string, string>;
  extractionMethod: string;
  confidence: number;
  coverage: number;
}

/** 解析后的文档负载 */
export interface ParsedDocumentPayload {
  docId: string;
  tables: RawTable[];
  refTextMap: Map<string, string>;
  nodeRefMap: Map<string, string>;
  extractionMethod: string;
  extractionConfidence: number;
  extractionCoverage: number;
}

/** 网格拓扑 */
/** 合并单元格信息 */
export interface MergedCellInfo {
  startRow: number;
  startCol: number;
  rowspan: number;
  colspan: number;
  sourceRef: string;
}

// ================================================================
// Layer 2: Logical Spatial Graph
// ================================================================

/** 空间关系类型 */
export type SpatialRelation =
  | "horizontal_adjacent"
  | "vertical_adjacent"
  | "same_section"
  | "aligned_horizontal"
  | "aligned_vertical"
  | "same_pattern_group";

/** 布局节点 */
export interface LayoutNode {
  id: string;
  tableIndex: number;
  ref: string;
  row: number;
  col: number;
  text: string;
  isMerged: boolean;
  mergedArea?: { rowspan: number; colspan: number };
}

/** 布局边 */
export interface LayoutEdge {
  source: string;
  target: string;
  relation: SpatialRelation;
  strength: number;
}

/** 区域 */
export interface Section {
  id: string;
  tableIndex: number;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  nodeIds: string[];
  type: "form_section" | "data_table" | "header" | "footer" | "unknown";
  confidence: number;
  boundaryType: "explicit" | "inferred" | "heuristic";
}

/** 重复模式 */
export interface RepeatedPattern {
  type: "row_pattern" | "column_pattern";
  templateRows: number[];
  occurrences: number[];
  nodeIds: string[][];
}

/** 单元格邻域 */
export interface CellNeighborhood {
  nodeId: string;
  tableIndex?: number;
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
  nearby: string[];
  sectionId?: string;
}

/** 对齐集群 */
export interface AlignmentCluster {
  direction: "horizontal" | "vertical";
  cells: string[];
  line: number;
}

/** 逻辑空间图 */
export interface LogicalSpatialGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  sections: Section[];
  repeatedPatterns: RepeatedPattern[];
  neighborhoods: Map<string, CellNeighborhood>;
}

// ================================================================
// Layer 3: Complexity Classifier
// ================================================================

/** 分析模式 */
export type AnalysisMode = "simple" | "standard" | "complex";

/** 复杂度评分 */
export interface ComplexityScore {
  score: number;
  mode: AnalysisMode;
  factors: {
    size: number;
    mergedCells: number;
    sections: number;
    patterns: number;
    emptyRatio: number;
    estimatedTokens: number;
  };
}

// ================================================================
// Layer 4: Structural Summarization
// ================================================================

/** 布局摘要 */
export interface LayoutSummary {
  tableType: "form" | "data_table" | "mixed";
  dimensions: { rows: number; cols: number };
  mergedCellCount: number;
  sectionCount: number;
  patternCount: number;
  description: string;
}

/** 区域摘要 */
export interface SectionSummary {
  sectionId: string;
  dimensions: { rows: number; cols: number };
  nodeCount: number;
  emptyCount: number;
  labelCount: number;
  description: string;
}

/** 结构化摘要 */
export interface StructuralSummary {
  layout: LayoutSummary;
  sections: SectionSummary[];
  patterns: string[];
  analysisMode: AnalysisMode;
}

// ================================================================
// Layer 5: Multi-pass LLM Understanding
// ================================================================

/** Pass 1: 布局理解结果 */
export interface LayoutUnderstanding {
  tableType: string;
  sectionBoundaries: Array<{
    startRow: number;
    endRow: number;
    purpose: string;
  }>;
  repeatedStructures: Array<{
    type: string;
    templateRows: number[];
  }>;
  fillableRegions: Array<{
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
    confidence: number;
  }>;
}

/** Pass 2: 区域理解结果 */
export interface SectionUnderstanding {
  sectionId: string;
  semanticMeaning: string;
  fieldGroups: Array<{
    name: string;
    nodeIds: string[];
  }>;
  rowPatterns: Array<{
    templateRow: number;
    repeatRows: number[];
    meaning: string;
  }>;
  writableAreas: Array<{
    nodeId: string;
    reason: string;
    confidence: number;
  }>;
}

/** Pass 3: 字段理解结果 */
export interface FieldUnderstanding {
  nodeId: string;
  role: CellRole;
  semanticType: SemanticType;
  confidence: number;
  spatialReason: string;
  semanticReason: string;
  neighboringNodes: string[];
}

// ================================================================
// Layer 6: Writable Region Detection
// ================================================================

/** Cell Role（系统核心） */
export type CellRole =
  | "label"
  | "value"
  | "empty_fillable"
  | "fillable_with_placeholder"
  | "section_title"
  | "table_header"
  | "readonly"
  | "computed"
  | "decorative"
  | "static_text"
  | "unknown";

/** 语义类型（开放领域） */
export interface SemanticType {
  generalType: string;
  domainType?: string;
}

/** 可写置信度 */
export interface WritableConfidence {
  structuralConfidence: number;
  semanticConfidence: number;
  patternConfidence: number;
  finalConfidence: number;
  factors: string[];
}

/** 重复可写模式 */
export interface RepeatedWritablePattern {
  patternId: string;
  templateNodes: string[];
  repeatedRows: number[];
  semanticMeaning: string;
  writableNodes: string[];
}

// ================================================================
// Layer 7: Analysis Artifacts
// ================================================================

/** 分析工件 */
export interface AnalysisArtifacts {
  docId: string;
  payload: ParsedDocumentPayload;
  graph: LogicalSpatialGraph;
  complexity: ComplexityScore;
  summary: StructuralSummary;
  layoutUnderstanding: LayoutUnderstanding;
  sectionUnderstandings: SectionUnderstanding[];
  fieldUnderstandings: FieldUnderstanding[];
  metadata: {
    analyzedAt: string;
    passCount: number;
    fallbackUsed: boolean;
    fallbackReason?: string;
  };
}

// ================================================================
// Layer 8: Semantic Document Schema
// ================================================================

/** Trace Level */
export type TraceLevel = "none" | "minimal" | "debug";

/** 分析追踪 */
export interface AnalysisTrace {
  level: TraceLevel;
  steps: Array<{
    step: string;
    reasoning: string;
    confidence: number;
    timestamp: string;
    input?: unknown;
    output?: unknown;
  }>;
}

/** 语义单元格 */
export interface SemanticCell {
  id: string;
  ref: string;
  tableIndex: number;
  row: number;
  col: number;
  text: string;
  role: CellRole;
  semanticType: SemanticType;
  writableConfidence: WritableConfidence;
  neighborhood: CellNeighborhood;
  traceId: string;
}

/** 语义区域 */
export interface SemanticSection {
  id: string;
  name: string;
  cells: SemanticCell[];
  writableCells: SemanticCell[];
  semanticMeaning: string;
  confidence: number;
  boundaryType: "explicit" | "inferred" | "heuristic";
}

/** 语义文档 Schema（唯一真相源） */
export interface SemanticDocumentSchema {
  schemaId: string;
  docId: string;
  layoutType: string;
  analysisMode: AnalysisMode;
  sections: SemanticSection[];
  allCells: SemanticCell[];
  writableCells: SemanticCell[];
  repeatedPatterns: RepeatedWritablePattern[];
  metadata: {
    analyzedAt: string;
    passCount: number;
    overallConfidence: number;
    traceLevel: TraceLevel;
  };
}

// ================================================================
// Layer 9: Execution Planner
// ================================================================

/** 填充约束 */
export interface FillConstraint {
  type: "single_target" | "avoid_readonly" | "prefer_multiline" | "prefer_repeated_section";
  weight: number;
}

/** 候选目标 */
export interface CandidateTarget {
  nodeId: string;
  ref: string;
  tableIndex?: number;
  row: number;
  col: number;
  confidence: number;
  reason: string;
  constraintScores: Record<string, number>;
  copyStyleFromReferenceNodeId?: string;
}

/** 填充计划 */
export interface FillPlan {
  fieldId: string;
  semanticMeaning: string;
  candidateTargets: CandidateTarget[];
  selectedTarget?: CandidateTarget;
  confidence: number;
  constraints: FillConstraint[];
  sectionContext: string;
}

/** 执行计划 */
export interface ExecutionPlan {
  planId: string;
  docId: string;
  schemaId: string;
  fillPlans: FillPlan[];
  metadata: {
    totalFields: number;
    highConfidenceCount: number;
    mappedCount?: number;
    lowConfidenceCount?: number;
    failedReasons?: string[];
    generatedAt: string;
  };
}

/** 归一化用户数据 */
export interface NormalizedUserData {
  [fieldName: string]: {
    value: string;
    aliases: string[];
    semanticType?: string;
  };
}

// ================================================================
// Layer 10: Document Fill Engine
// ================================================================

/** 执行选项 */
export interface ExecutionOptions {
  dryRun: boolean;
  validateOnly: boolean;
}

/** 写入结果 */
export interface WriteResult {
  success: boolean;
  ref: string;
  value: string;
  beforeValue?: string;
  error?: string;
}

/** 事务状态 */
export type TransactionStatus = "pending" | "committed" | "rolled_back";

/** 事务 */
export interface Transaction {
  id: string;
  status: TransactionStatus;
  writes: WriteResult[];
  startedAt: string;
  completedAt?: string;
}

// ================================================================
// Cache Types
// ================================================================

/** 缓存 Key */
export interface CacheKey {
  docHash: string;
  analysisVersion: string;
  sdkVersion: string;
}

// ================================================================
// Error Types
// ================================================================

export class DocAnalystError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DocAnalystError";
  }
}

export class DocumentReadError extends DocAnalystError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "DocumentReadError";
  }
}

export class LLMAnalysisError extends DocAnalystError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LLMAnalysisError";
  }
}

export class SchemaValidationError extends DocAnalystError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "SchemaValidationError";
  }
}

export function makeCellNodeId(tableIndex: number, row: number, col: number): string {
  return `table_${tableIndex}_node_${row}_${col}`;
}

export function parseCellNodeId(nodeId: string): { tableIndex: number; row: number; col: number } | null {
  const scoped = nodeId.match(/^table_(\d+)_node_(\d+)_(\d+)$/);
  if (scoped) {
    return {
      tableIndex: Number.parseInt(scoped[1], 10),
      row: Number.parseInt(scoped[2], 10),
      col: Number.parseInt(scoped[3], 10),
    };
  }

  const legacy = nodeId.match(/^node_(\d+)_(\d+)$/);
  if (legacy) {
    return {
      tableIndex: 0,
      row: Number.parseInt(legacy[1], 10),
      col: Number.parseInt(legacy[2], 10),
    };
  }

  return null;
}
