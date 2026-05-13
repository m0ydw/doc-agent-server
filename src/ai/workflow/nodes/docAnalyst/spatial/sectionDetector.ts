/**
 * ================================================================
 * 区域边界检测器
 * ================================================================
 *
 * 检测表格中的区域边界
 */

import type { LayoutNode, LayoutEdge, Section, RawCell } from "../types";

/**
 * 检测区域边界
 *
 * 区域检测策略：
 * 1. 空行分隔
 * 2. 合并单元格边界
 * 3. 内容类型变化
 */
export function detectSections(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  cells: RawCell[],
  rows: number,
  cols: number,
  tableIndex: number = 0
): Section[] {
  const sections: Section[] = [];

  // 策略1: 基于空行检测区域
  const emptyRows = findEmptyRows(cells, rows, cols);
  const boundaries = findBoundariesFromEmptyRows(emptyRows, rows);

  // 策略2: 基于合并单元格检测区域
  const mergedBoundaries = findBoundariesFromMergedCells(cells, rows, cols);

  // 合并边界
  const allBoundaries = mergeBoundaries(boundaries, mergedBoundaries, rows);

  // 构建区域
  for (let i = 0; i < allBoundaries.length; i++) {
    const { startRow, endRow } = allBoundaries[i];
    const sectionNodes = nodes.filter(n => n.row >= startRow && n.row <= endRow);

    if (sectionNodes.length > 0) {
      sections.push({
        id: `table_${tableIndex}_section_${i}`,
        tableIndex,
        startRow,
        endRow,
        startCol: 0,
        endCol: cols - 1,
        nodeIds: sectionNodes.map(n => n.id),
        type: inferSectionType(sectionNodes, cells),
        confidence: 0.7,
        boundaryType: "inferred",
      });
    }
  }

  // 如果没有检测到区域，整个表格作为一个区域
  if (sections.length === 0 && nodes.length > 0) {
    sections.push({
      id: `table_${tableIndex}_section_0`,
      tableIndex,
      startRow: 0,
      endRow: rows - 1,
      startCol: 0,
      endCol: cols - 1,
      nodeIds: nodes.map(n => n.id),
      type: "unknown",
      confidence: 0.5,
      boundaryType: "heuristic",
    });
  }

  return sections;
}

/**
 * 查找空行
 */
function findEmptyRows(cells: RawCell[], rows: number, cols: number): number[] {
  const emptyRows: number[] = [];

  for (let row = 0; row < rows; row++) {
    const rowCells = cells.filter(c => c.row === row);
    const hasContent = rowCells.some(c => c.text && c.text.trim() !== "" && c.text !== "[TEXT_UNAVAILABLE]");

    if (!hasContent) {
      emptyRows.push(row);
    }
  }

  return emptyRows;
}

/**
 * 从空行查找边界
 */
function findBoundariesFromEmptyRows(
  emptyRows: number[],
  totalRows: number
): Array<{ startRow: number; endRow: number }> {
  const boundaries: Array<{ startRow: number; endRow: number }> = [];

  if (emptyRows.length === 0) {
    boundaries.push({ startRow: 0, endRow: totalRows - 1 });
    return boundaries;
  }

  let startRow = 0;
  for (const emptyRow of emptyRows) {
    if (emptyRow > startRow) {
      boundaries.push({ startRow, endRow: emptyRow - 1 });
    }
    startRow = emptyRow + 1;
  }

  if (startRow < totalRows) {
    boundaries.push({ startRow, endRow: totalRows - 1 });
  }

  return boundaries;
}

/**
 * 从合并单元格查找边界
 */
function findBoundariesFromMergedCells(
  cells: RawCell[],
  rows: number,
  cols: number
): Array<{ startRow: number; endRow: number }> {
  const boundaries: Array<{ startRow: number; endRow: number }> = [];

  // 查找跨多列的合并单元格（可能是标题行）
  const wideMergedCells = cells.filter(c => c.colspan >= cols / 2);

  for (const cell of wideMergedCells) {
    boundaries.push({
      startRow: cell.row,
      endRow: cell.row,
    });
  }

  return boundaries;
}

/**
 * 合并边界
 */
function mergeBoundaries(
  boundaries1: Array<{ startRow: number; endRow: number }>,
  boundaries2: Array<{ startRow: number; endRow: number }>,
  totalRows: number
): Array<{ startRow: number; endRow: number }> {
  // 简单实现：合并所有边界并排序
  const allBoundaries = [...boundaries1, ...boundaries2];
  allBoundaries.sort((a, b) => a.startRow - b.startRow);

  // 合并重叠的边界
  const merged: Array<{ startRow: number; endRow: number }> = [];
  for (const boundary of allBoundaries) {
    if (merged.length === 0) {
      merged.push(boundary);
    } else {
      const last = merged[merged.length - 1];
      if (boundary.startRow <= last.endRow + 1) {
        last.endRow = Math.max(last.endRow, boundary.endRow);
      } else {
        merged.push(boundary);
      }
    }
  }

  return merged;
}

/**
 * 推断区域类型
 */
function inferSectionType(
  nodes: LayoutNode[],
  cells: RawCell[]
): Section["type"] {
  // 检查是否是表头（第一行）
  const minRow = Math.min(...nodes.map(n => n.row));
  if (minRow === 0) {
    return "header";
  }

  // 检查是否有跨多列的合并单元格（可能是标题）
  const sectionCells = cells.filter(c =>
    nodes.some(n => n.row === c.row && n.col === c.col)
  );
  const hasWideCell = sectionCells.some(c => c.colspan >= 3);
  if (hasWideCell) {
    return "form_section";
  }

  return "unknown";
}
