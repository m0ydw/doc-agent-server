import type { ParsedDocumentPayload, RawCell } from "../docAnalyst/types";

export interface TableCellRef {
  tableIndex: number;
  row: number;
  col: number;
  ref: string;
  nodeId: string;
  text: string;
  rowspan: number;
  colspan: number;
  gridColEnd: number;  // col + colspan
}

export interface DocumentTableMap {
  docId: string;
  tables: Array<{
    index: number;
    rows: number;
    cols: number;
    cells: TableCellRef[];
  }>;
}

export interface ReferenceFieldTemplate {
  fieldPath: string;
  value: string;
  tableIndex: number;
  row: number;
  col: number;
  referenceNodeId: string;
  referenceRef: string;
  confidence: number;
  reason: string;
}

export interface TableFillAnalysis {
  analysisId: string;
  referenceDocId: string;
  targetDocId: string;
  reference: DocumentTableMap;
  target: DocumentTableMap;
  templates: ReferenceFieldTemplate[];
  failedReasons: string[];
  createdAt: string;
}

export interface TableFillPlanStats {
  recognizedFields: number;
  mappedFields: number;
  lowConfidenceCount: number;
  failedReasons: string[];
}

export function toDocumentTableMap(payload: ParsedDocumentPayload): DocumentTableMap {
  return {
    docId: payload.docId,
    tables: payload.tables.map(table => ({
      index: table.index,
      rows: table.rows,
      cols: table.cols,
      cells: table.cells.map(toTableCellRef),
    })),
  };
}

function toTableCellRef(cell: RawCell): TableCellRef {
  return {
    tableIndex: cell.tableIndex,
    row: cell.row,
    col: cell.col,
    ref: cell.ref,
    nodeId: cell.nodeId,
    text: normalizeText(cell.text),
    rowspan: cell.rowspan,
    colspan: cell.colspan,
    gridColEnd: cell.col + cell.colspan,
  };
}

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")  // 合并多个空白字符
    .replace(/[\r\n]+/g, " ")  // 合并换行符
    .replace(/[\u200B-\u200D\uFEFF]/g, "")  // 去除不可见字符（零宽空格等）
    .replace(/[：:]/g, ":")  // 统一冒号
    .replace(/[，,]/g, ",")  // 统一逗号
    .replace(/[；;]/g, ";")  // 统一分号
    .trim();
}
