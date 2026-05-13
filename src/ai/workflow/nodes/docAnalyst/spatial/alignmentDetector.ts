/**
 * ================================================================
 * 对齐检测器
 * ================================================================
 *
 * 检测单元格之间的对齐关系
 */

import type { LayoutNode, AlignmentCluster } from "../types";

/**
 * 检测水平对齐（同一行的单元格）
 */
export function detectHorizontalAlignment(nodes: LayoutNode[]): AlignmentCluster[] {
  const clusters: AlignmentCluster[] = [];

  // 按行分组
  const rowMap = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    if (!rowMap.has(node.row)) {
      rowMap.set(node.row, []);
    }
    rowMap.get(node.row)!.push(node);
  }

  // 每一行是一个水平对齐集群
  for (const [row, rowNodes] of rowMap) {
    if (rowNodes.length > 1) {
      clusters.push({
        direction: "horizontal",
        cells: rowNodes.map(n => n.id),
        line: row,
      });
    }
  }

  return clusters;
}

/**
 * 检测垂直对齐（同一列的单元格）
 */
export function detectVerticalAlignment(nodes: LayoutNode[]): AlignmentCluster[] {
  const clusters: AlignmentCluster[] = [];

  // 按列分组
  const colMap = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    if (!colMap.has(node.col)) {
      colMap.set(node.col, []);
    }
    colMap.get(node.col)!.push(node);
  }

  // 每一列是一个垂直对齐集群
  for (const [col, colNodes] of colMap) {
    if (colNodes.length > 1) {
      clusters.push({
        direction: "vertical",
        cells: colNodes.map(n => n.id),
        line: col,
      });
    }
  }

  return clusters;
}

/**
 * 检测所有对齐关系
 */
export function detectAlignments(nodes: LayoutNode[]): AlignmentCluster[] {
  return [
    ...detectHorizontalAlignment(nodes),
    ...detectVerticalAlignment(nodes),
  ];
}
