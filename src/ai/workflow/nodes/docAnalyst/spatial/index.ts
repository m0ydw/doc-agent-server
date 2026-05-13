import type {
  ParsedDocumentPayload,
  LogicalSpatialGraph,
  LayoutNode,
  RawCell,
} from "../types";
import { makeCellNodeId } from "../types";
import { analyzeAdjacency } from "./adjacencyAnalyzer";
import { detectAlignments } from "./alignmentDetector";
import { detectSections } from "./sectionDetector";
import { detectRepeatedPatterns } from "./patternDetector";
import { buildNeighborhoods } from "./neighborhoodBuilder";

export function buildSpatialGraph(payload: ParsedDocumentPayload): LogicalSpatialGraph {
  if (payload.tables.length === 0) {
    return {
      nodes: [],
      edges: [],
      sections: [],
      repeatedPatterns: [],
      neighborhoods: new Map(),
    };
  }

  const nodes: LogicalSpatialGraph["nodes"] = [];
  const edges: LogicalSpatialGraph["edges"] = [];
  const sections: LogicalSpatialGraph["sections"] = [];
  const repeatedPatterns: LogicalSpatialGraph["repeatedPatterns"] = [];
  const neighborhoods: LogicalSpatialGraph["neighborhoods"] = new Map();

  for (const table of payload.tables) {
    const tableNodes = buildLayoutNodes(table.cells, table.index);
    const tableEdges = analyzeAdjacency(tableNodes);

    // Alignment detection is retained as a deterministic structural pass.
    detectAlignments(tableNodes);

    const tableSections = detectSections(
      tableNodes,
      tableEdges,
      table.cells,
      table.rows,
      table.cols,
      table.index
    );
    const tablePatterns = detectRepeatedPatterns(tableNodes, table.cells, table.rows, table.cols);
    const tableNeighborhoods = buildNeighborhoods(tableNodes, tableEdges, tableSections);

    nodes.push(...tableNodes);
    edges.push(...tableEdges);
    sections.push(...tableSections);
    repeatedPatterns.push(...tablePatterns);
    for (const [nodeId, neighborhood] of tableNeighborhoods) {
      neighborhoods.set(nodeId, neighborhood);
    }
  }

  return {
    nodes,
    edges,
    sections,
    repeatedPatterns,
    neighborhoods,
  };
}

function buildLayoutNodes(cells: RawCell[], tableIndex: number): LayoutNode[] {
  return cells.map(cell => ({
    id: makeCellNodeId(tableIndex, cell.row, cell.col),
    tableIndex,
    ref: cell.ref,
    row: cell.row,
    col: cell.col,
    text: cell.text,
    isMerged: cell.rowspan > 1 || cell.colspan > 1,
    mergedArea: cell.rowspan > 1 || cell.colspan > 1
      ? { rowspan: cell.rowspan, colspan: cell.colspan }
      : undefined,
  }));
}

export { analyzeAdjacency } from "./adjacencyAnalyzer";
export { detectAlignments } from "./alignmentDetector";
export { detectSections } from "./sectionDetector";
export { detectRepeatedPatterns } from "./patternDetector";
export { buildNeighborhoods } from "./neighborhoodBuilder";
