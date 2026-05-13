/**
 * ================================================================
 * 单元格提取器
 * ================================================================
 *
 * 批量提取所有单元格数据
 */

import type { Document } from "../../../../../services/cliRunner";
import type { RawCell, RawTable, MergedCellInfo } from "../types";

/**
 * 从表格获取所有单元格
 */
export async function extractCellsFromTable(
  doc: Document,
  tableNodeId: string,
  tableIndex: number,
  nodeRefMap: Map<string, string>,
  refTextMap: Map<string, string>
): Promise<RawTable> {
  const target = {
    kind: "block",
    nodeType: "table",
    nodeId: tableNodeId,
  };

  // 获取表格维度
  const tableInfo = await doc.tables.get({ target });
  const rows = ((tableInfo as Record<string, unknown>).rows as number) || 0;
  const cols = ((tableInfo as Record<string, unknown>).columns as number) || 0;

  // 获取单元格坐标（含合并信息）
  const cellsResult = await doc.tables.getCells({ target });
  const rawCells = (((cellsResult as Record<string, unknown>).cells || []) as Array<{
    nodeId: string;
    rowIndex: number;
    columnIndex: number;
    colspan: number;
    rowspan: number;
  }>);

  const minRow = rawCells.length > 0 ? Math.min(...rawCells.map(cell => cell.rowIndex)) : 0;
  const minCol = rawCells.length > 0 ? Math.min(...rawCells.map(cell => cell.columnIndex)) : 0;

  // 构建 RawCell 列表
  const cells: RawCell[] = [];
  for (const rawCell of rawCells) {
    const nodeId = rawCell.nodeId;
    const ref = nodeRefMap.get(nodeId) || nodeId;
    const text = refTextMap.get(ref) ?? refTextMap.get(nodeId) ?? "";

    cells.push({
      tableIndex,
      row: rawCell.rowIndex - minRow,
      col: rawCell.columnIndex - minCol,
      ref,
      text,
      rowspan: rawCell.rowspan || 1,
      colspan: rawCell.colspan || 1,
      nodeId,
    });
  }

  return {
    index: tableIndex,
    rows,
    cols,
    cells,
  };
}

/**
 * 检测合并单元格
 */
export function detectMergedCells(cells: RawCell[], rows: number, cols: number): MergedCellInfo[] {
  const mergedCells: MergedCellInfo[] = [];

  for (const cell of cells) {
    if (cell.rowspan > 1 || cell.colspan > 1) {
      mergedCells.push({
        startRow: cell.row,
        startCol: cell.col,
        rowspan: cell.rowspan,
        colspan: cell.colspan,
        sourceRef: cell.ref,
      });
    }
  }

  return mergedCells;
}

/**
 * 构建网格拓扑
 */
export function buildGrid(
  cells: RawCell[],
  rows: number,
  cols: number
): (RawCell | null)[][] {
  // 初始化网格
  const grid: (RawCell | null)[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(null)
  );

  // 填充网格
  for (const cell of cells) {
    if (cell.row < rows && cell.col < cols) {
      grid[cell.row][cell.col] = cell;
    }
  }

  return grid;
}
