import type {
  ParsedDocumentPayload,
  LogicalSpatialGraph,
  LayoutUnderstanding,
  FieldUnderstanding,
  CellRole,
  SemanticType,
  CellNeighborhood,
  RawCell,
} from "../types";
import { makeCellNodeId, parseCellNodeId } from "../types";

export function heuristicLayoutAnalysis(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph
): LayoutUnderstanding {
  const totalTables = payload.tables.length;
  const totalCells = payload.tables.reduce((sum, table) => sum + table.cells.length, 0);
  const mergedCells = payload.tables.reduce(
    (sum, table) => sum + table.cells.filter(c => c.rowspan > 1 || c.colspan > 1).length,
    0
  );

  let tableType = "mixed";
  if (totalTables === 1 && graph.sections.length <= 1 && mergedCells < totalCells * 0.2) {
    tableType = "data_table";
  } else if (graph.sections.length >= 2 || mergedCells >= totalCells * 0.2) {
    tableType = "form";
  }

  return {
    tableType,
    sectionBoundaries: graph.sections.map(section => ({
      startRow: section.startRow,
      endRow: section.endRow,
      purpose: section.type,
    })),
    repeatedStructures: graph.repeatedPatterns.map(pattern => ({
      type: pattern.type,
      templateRows: pattern.templateRows,
    })),
    fillableRegions: inferFillableRegions(payload),
  };
}

function inferFillableRegions(payload: ParsedDocumentPayload): LayoutUnderstanding["fillableRegions"] {
  const regions: LayoutUnderstanding["fillableRegions"] = [];

  for (const table of payload.tables) {
    const emptyRows = [...new Set(table.cells
      .filter(isEmptyCell)
      .map(cell => cell.row))]
      .sort((a, b) => a - b);

    if (emptyRows.length === 0) continue;

    let startRow = emptyRows[0];
    let endRow = emptyRows[0];
    for (let i = 1; i < emptyRows.length; i++) {
      if (emptyRows[i] === endRow + 1) {
        endRow = emptyRows[i];
      } else {
        regions.push({ startRow, endRow, startCol: 0, endCol: table.cols - 1, confidence: 0.5 });
        startRow = emptyRows[i];
        endRow = emptyRows[i];
      }
    }
    regions.push({ startRow, endRow, startCol: 0, endCol: table.cols - 1, confidence: 0.5 });
  }

  return regions;
}

export function heuristicFieldAnalysis(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph
): FieldUnderstanding[] {
  const results: FieldUnderstanding[] = [];

  for (const table of payload.tables) {
    for (const cell of table.cells) {
      const nodeId = makeCellNodeId(table.index, cell.row, cell.col);
      const neighborhood = graph.neighborhoods.get(nodeId);
      const { role, confidence, spatialReason } = inferCellRole(cell, neighborhood, payload);

      results.push({
        nodeId,
        role,
        semanticType: inferSemanticType(cell.text, role),
        confidence,
        spatialReason,
        semanticReason: "heuristic fallback",
        neighboringNodes: neighborhood?.nearby || [],
      });
    }
  }

  return results;
}

function inferCellRole(
  cell: RawCell,
  neighborhood: CellNeighborhood | undefined,
  payload: ParsedDocumentPayload
): { role: CellRole; confidence: number; spatialReason: string } {
  const text = normalizeCellText(cell.text);

  if (!text) {
    return hasNeighborWithText(neighborhood, payload)
      ? { role: "empty_fillable", confidence: 0.65, spatialReason: "empty cell beside a label/value cell" }
      : { role: "unknown", confidence: 0.35, spatialReason: "empty cell without clear label context" };
  }

  if (isPlaceholderText(text)) {
    return { role: "fillable_with_placeholder", confidence: 0.75, spatialReason: "placeholder-like content" };
  }

  if (cell.row === 0 || cell.colspan > 1) {
    return { role: "table_header", confidence: 0.55, spatialReason: "header row or merged header cell" };
  }

  if (text.length <= 20 || /[:：]$/.test(text)) {
    return { role: "label", confidence: 0.55, spatialReason: "short label-like text" };
  }

  return { role: "readonly", confidence: 0.45, spatialReason: "long static text" };
}

function isEmptyCell(cell: RawCell): boolean {
  return normalizeCellText(cell.text) === "";
}

function normalizeCellText(text: string): string {
  if (!text || text === "[TEXT_UNAVAILABLE]") return "";
  return text.trim();
}

function isPlaceholderText(text: string): boolean {
  return /^(placeholder|fill|填写|请输入|请填写|待填|___+|--+)$/i.test(text.trim());
}

function hasNeighborWithText(
  neighborhood: CellNeighborhood | undefined,
  payload: ParsedDocumentPayload
): boolean {
  if (!neighborhood) return false;

  const neighborIds = [neighborhood.top, neighborhood.bottom, neighborhood.left, neighborhood.right]
    .filter(Boolean) as string[];

  return neighborIds.some(nodeId => {
    const parsed = parseCellNodeId(nodeId);
    if (!parsed) return false;
    const table = payload.tables.find(t => t.index === parsed.tableIndex);
    const cell = table?.cells.find(c => c.row === parsed.row && c.col === parsed.col);
    return !!cell && normalizeCellText(cell.text) !== "";
  });
}

function inferSemanticType(text: string, role: CellRole): SemanticType {
  if (role !== "label" && role !== "fillable_with_placeholder" && role !== "table_header") {
    return { generalType: "unknown" };
  }

  if (/phone|tel|mobile|电话|手机|联系方式/i.test(text)) {
    return { generalType: "contact", domainType: "phone" };
  }
  if (/mail|email|邮箱/i.test(text)) {
    return { generalType: "contact", domainType: "email" };
  }
  if (/address|地址/i.test(text)) {
    return { generalType: "location", domainType: "address" };
  }
  if (/name|姓名|名称/i.test(text)) {
    return { generalType: "person", domainType: "name" };
  }
  if (/date|time|日期|时间/i.test(text)) {
    return { generalType: "temporal", domainType: "date" };
  }

  return { generalType: "unknown" };
}

export function calculateSpatialConfidence(graph: LogicalSpatialGraph): number {
  if (graph.nodes.length === 0) return 0;
  return Math.min(graph.edges.length / (graph.nodes.length * 4), 1);
}

export function calculatePatternConfidence(graph: LogicalSpatialGraph): number {
  if (graph.repeatedPatterns.length === 0) return 0.3;

  const avgOccurrences = graph.repeatedPatterns.reduce(
    (sum, pattern) => sum + pattern.occurrences.length,
    0
  ) / graph.repeatedPatterns.length;

  return Math.min(avgOccurrences / 3, 1);
}

export function calculateStructureConfidence(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph
): number {
  const totalRows = payload.tables.reduce((sum, table) => sum + table.rows, 0);
  if (totalRows === 0) return 0;

  const coveredRows = graph.sections.reduce(
    (sum, section) => sum + (section.endRow - section.startRow + 1),
    0
  );

  return Math.min(coveredRows / totalRows, 1);
}

export function weightedAverage(values: Array<{ value: number; weight: number }>): number {
  const totalWeight = values.reduce((sum, value) => sum + value.weight, 0);
  if (totalWeight === 0) return 0;

  return values.reduce((sum, value) => sum + value.value * value.weight, 0) / totalWeight;
}
