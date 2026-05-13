/**
 * ================================================================
 * 邻接分析器
 * ================================================================
 *
 * 分析单元格之间的水平和垂直邻接关系
 */

import type { LayoutNode, LayoutEdge, RawCell } from "../types";

/**
 * 分析水平邻接关系
 */
export function analyzeHorizontalAdjacency(nodes: LayoutNode[]): LayoutEdge[] {
  const edges: LayoutEdge[] = [];

  // 按行分组
  const rowMap = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    if (!rowMap.has(node.row)) {
      rowMap.set(node.row, []);
    }
    rowMap.get(node.row)!.push(node);
  }

  // 分析每行的邻接关系
  for (const [, rowNodes] of rowMap) {
    // 按列排序
    rowNodes.sort((a, b) => a.col - b.col);

    for (let i = 0; i < rowNodes.length - 1; i++) {
      const current = rowNodes[i];
      const next = rowNodes[i + 1];

      // 检查是否相邻（考虑 colspan）
      const currentEndCol = current.col + (current.mergedArea?.colspan || 1);
      if (currentEndCol === next.col) {
        edges.push({
          source: current.id,
          target: next.id,
          relation: "horizontal_adjacent",
          strength: 1.0,
        });
      }
    }
  }

  return edges;
}

/**
 * 分析垂直邻接关系
 */
export function analyzeVerticalAdjacency(nodes: LayoutNode[]): LayoutEdge[] {
  const edges: LayoutEdge[] = [];

  // 按列分组
  const colMap = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    if (!colMap.has(node.col)) {
      colMap.set(node.col, []);
    }
    colMap.get(node.col)!.push(node);
  }

  // 分析每列的邻接关系
  for (const [, colNodes] of colMap) {
    // 按行排序
    colNodes.sort((a, b) => a.row - b.row);

    for (let i = 0; i < colNodes.length - 1; i++) {
      const current = colNodes[i];
      const next = colNodes[i + 1];

      // 检查是否相邻（考虑 rowspan）
      const currentEndRow = current.row + (current.mergedArea?.rowspan || 1);
      if (currentEndRow === next.row) {
        edges.push({
          source: current.id,
          target: next.id,
          relation: "vertical_adjacent",
          strength: 1.0,
        });
      }
    }
  }

  return edges;
}

/**
 * 分析所有邻接关系
 */
export function analyzeAdjacency(nodes: LayoutNode[]): LayoutEdge[] {
  return [
    ...analyzeHorizontalAdjacency(nodes),
    ...analyzeVerticalAdjacency(nodes),
  ];
}
