import type {
  ParsedDocumentPayload,
  LogicalSpatialGraph,
  StructuralSummary,
  LayoutSummary,
  SectionSummary,
  AnalysisMode,
} from "../types";

export function generateStructuralSummary(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph,
  mode: AnalysisMode
): StructuralSummary {
  return {
    layout: summarizeLayout(payload, graph),
    sections: graph.sections.map(section => summarizeSection(section, payload)),
    patterns: summarizePatterns(graph.repeatedPatterns),
    analysisMode: mode,
  };
}

function summarizeLayout(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph
): LayoutSummary {
  const rows = payload.tables.reduce((sum, table) => sum + table.rows, 0);
  const cols = payload.tables.reduce((max, table) => Math.max(max, table.cols), 0);
  const cells = payload.tables.flatMap(table => table.cells);
  const mergedCellCount = cells.filter(cell => cell.rowspan > 1 || cell.colspan > 1).length;

  let tableType: LayoutSummary["tableType"] = "mixed";
  if (payload.tables.length === 1 && graph.sections.length <= 1 && mergedCellCount < cells.length * 0.2) {
    tableType = "data_table";
  } else if (graph.sections.length >= 2 || mergedCellCount >= cells.length * 0.2) {
    tableType = "form";
  }

  return {
    tableType,
    dimensions: { rows, cols },
    mergedCellCount,
    sectionCount: graph.sections.length,
    patternCount: graph.repeatedPatterns.length,
    description: `${payload.tables.length} table(s), ${rows} total rows, max ${cols} columns`,
  };
}

function summarizeSection(
  section: LogicalSpatialGraph["sections"][0],
  payload: ParsedDocumentPayload
): SectionSummary {
  const table = payload.tables.find(t => t.index === section.tableIndex);
  const sectionCells = table?.cells.filter(
    cell => cell.row >= section.startRow && cell.row <= section.endRow
  ) || [];

  const emptyCount = sectionCells.filter(
    cell => !cell.text || cell.text.trim() === "" || cell.text === "[TEXT_UNAVAILABLE]"
  ).length;
  const labelCount = sectionCells.filter(
    cell => cell.text && cell.text.trim().length > 0 && cell.text.trim().length < 20 && cell.text !== "[TEXT_UNAVAILABLE]"
  ).length;
  const rows = section.endRow - section.startRow + 1;
  const cols = section.endCol - section.startCol + 1;

  return {
    sectionId: section.id,
    dimensions: { rows, cols },
    nodeCount: sectionCells.length,
    emptyCount,
    labelCount,
    description: `${section.type} in table ${section.tableIndex}, ${rows}x${cols}`,
  };
}

function summarizePatterns(patterns: LogicalSpatialGraph["repeatedPatterns"]): string[] {
  return patterns.map(pattern =>
    `${pattern.type}: ${pattern.templateRows.length} template row(s), ${pattern.occurrences.length} occurrence(s)`
  );
}
