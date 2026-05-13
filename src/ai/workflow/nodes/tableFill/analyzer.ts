import { randomUUID } from "crypto";
import { parseDocument } from "../docAnalyst/parser";
import type { TableFillAnalysis, ReferenceFieldTemplate, TableCellRef } from "./types";
import { normalizeText, toDocumentTableMap } from "./types";
import { saveTableFillAnalysis } from "./store";

export async function analyzeReferenceAndTargetTables(
  referenceDocId: string,
  targetDocId: string,
  userData: Record<string, unknown>,
): Promise<TableFillAnalysis> {
  const referencePayload = await parseDocument(referenceDocId, true);
  const targetPayload = await parseDocument(targetDocId, true);
  const reference = toDocumentTableMap(referencePayload);
  const target = toDocumentTableMap(targetPayload);
  const failedReasons: string[] = [];

  const templates = buildReferenceTemplates(reference.tables.flatMap(table => table.cells), userData, failedReasons);

  const analysis: TableFillAnalysis = {
    analysisId: `table_fill_${randomUUID()}`,
    referenceDocId,
    targetDocId,
    reference,
    target,
    templates,
    failedReasons,
    createdAt: new Date().toISOString(),
  };

  saveTableFillAnalysis(analysis);
  return analysis;
}

function buildReferenceTemplates(
  cells: TableCellRef[],
  userData: Record<string, unknown>,
  failedReasons: string[],
): ReferenceFieldTemplate[] {
  const templates: ReferenceFieldTemplate[] = [];
  const textCells = cells.filter(cell => normalizeText(cell.text));
  const flatFields = flattenUserData(userData);

  for (const field of flatFields) {
    const direct = findCellByText(textCells, field.value);
    if (direct) {
      templates.push(toTemplate(field.path, field.value, direct, 0.96, "matched by reference value text"));
      continue;
    }

    const labelBased = findByLabelAndPosition(cells, field.path);
    if (labelBased) {
      templates.push(toTemplate(field.path, field.value, labelBased, 0.88, "matched by reference label neighborhood"));
      continue;
    }

    const tableBased = findByArrayTablePosition(cells, field.path);
    if (tableBased) {
      templates.push(toTemplate(field.path, field.value, tableBased, 0.82, "matched by repeated table header position"));
      continue;
    }

    failedReasons.push(`No reference position template for field: ${field.path}`);
  }

  return templates;
}

function toTemplate(
  fieldPath: string,
  value: string,
  cell: TableCellRef,
  confidence: number,
  reason: string,
): ReferenceFieldTemplate {
  return {
    fieldPath,
    value,
    tableIndex: cell.tableIndex,
    row: cell.row,
    col: cell.col,
    referenceNodeId: cell.nodeId,
    referenceRef: cell.ref,
    confidence,
    reason,
  };
}

function flattenUserData(data: Record<string, unknown>): Array<{ path: string; value: string }> {
  const fields: Array<{ path: string; value: string }> = [];

  for (const [key, value] of Object.entries(data)) {
    appendValue(fields, key, value);
  }

  return fields.filter(field => field.value.trim());
}

function appendValue(fields: Array<{ path: string; value: string }>, path: string, value: unknown): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => appendValue(fields, `${path}.${index}`, item));
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      appendValue(fields, `${path}.${key}`, child);
    }
    return;
  }

  fields.push({ path, value: normalizeText(value) });
}

function findCellByText(cells: TableCellRef[], value: string): TableCellRef | undefined {
  const wanted = normalizeComparable(value);
  if (!wanted) return undefined;

  return cells.find(cell => normalizeComparable(cell.text) === wanted)
    || cells.find(cell => normalizeComparable(cell.text).includes(wanted));
}

function findByLabelAndPosition(cells: TableCellRef[], fieldPath: string): TableCellRef | undefined {
  const keyParts = fieldPath.split(".");
  const key = keyParts[keyParts.length - 1] || fieldPath;
  const canonicalKey = normalizeComparable(key);
  const label = cells.find(cell => {
    const text = normalizeComparable(cell.text);
    return text && (text === canonicalKey || text.includes(canonicalKey) || canonicalKey.includes(text));
  });

  if (!label) return undefined;

  const sameTable = cells.filter(cell => cell.tableIndex === label.tableIndex);
  const right = sameTable
    .filter(cell => cell.row === label.row && cell.col > label.col)
    .sort((a, b) => a.col - b.col)[0];
  if (right) return right;

  return sameTable
    .filter(cell => cell.col === label.col && cell.row > label.row)
    .sort((a, b) => a.row - b.row)[0];
}

function findByArrayTablePosition(cells: TableCellRef[], fieldPath: string): TableCellRef | undefined {
  const parts = fieldPath.split(".");
  if (parts.length < 3) return undefined;

  const rowOffset = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(rowOffset)) return undefined;

  const columnName = parts[parts.length - 1] || "";
  const canonicalColumn = normalizeComparable(columnName);
  const header = cells.find(cell => {
    const text = normalizeComparable(cell.text);
    return text && (text === canonicalColumn || text.includes(canonicalColumn) || canonicalColumn.includes(text));
  });

  if (!header) return undefined;

  const sameTable = cells.filter(cell => cell.tableIndex === header.tableIndex);
  const candidateRow = header.row + 1 + rowOffset;
  return sameTable.find(cell => cell.row === candidateRow && cell.col === header.col);
}

function normalizeComparable(value: string): string {
  return normalizeText(value)
    .replace(/[：:：，,；;。.\s]/g, "")
    .toLowerCase();
}
