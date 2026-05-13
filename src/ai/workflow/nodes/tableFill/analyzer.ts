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
  console.log(`[DocAnalyst] 开始分析参考/目标文档...`);
  console.log(`[DocAnalyst]   referenceDocId: ${referenceDocId}`);
  console.log(`[DocAnalyst]   targetDocId: ${targetDocId}`);

  const referencePayload = await parseDocument(referenceDocId, true);
  const targetPayload = await parseDocument(targetDocId, true);
  const reference = toDocumentTableMap(referencePayload);
  const target = toDocumentTableMap(targetPayload);
  const failedReasons: string[] = [];

  // 增强日志：记录表格结构
  console.log(`[DocAnalyst] Reference tables=${reference.tables.length}, target tables=${target.tables.length}`);
  for (let i = 0; i < reference.tables.length; i++) {
    const table = reference.tables[i];
    console.log(`[DocAnalyst] Reference table ${i}: ${table.rows} rows x ${table.cols} cols, ${table.cells.length} cells`);
  }

  const templates = buildReferenceTemplates(reference.tables.flatMap(table => table.cells), userData, failedReasons);

  // 增强日志：记录模板提取结果
  console.log(`[DocAnalyst] Field templates=${templates.length}, failed=${failedReasons.length}`);
  if (templates.length === 0) {
    console.warn(`[DocAnalyst] ⚠️ 未能提取任何字段模板！`);
    console.warn(`[DocAnalyst] 失败原因:`);
    for (const reason of failedReasons.slice(0, 10)) {
      console.warn(`[DocAnalyst]   - ${reason}`);
    }
    if (failedReasons.length > 10) {
      console.warn(`[DocAnalyst]   ... 还有 ${failedReasons.length - 10} 个失败原因`);
    }

    // 输出 table matrix dump 用于调试
    console.log(`[DocAnalyst] Reference document table matrix dump:`);
    for (let i = 0; i < reference.tables.length; i++) {
      const table = reference.tables[i];
      console.log(`[DocAnalyst] Table ${i}:`);
      const rowMap = new Map<number, TableCellRef[]>();
      for (const cell of table.cells) {
        if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
        rowMap.get(cell.row)!.push(cell);
      }
      for (let row = 0; row < table.rows; row++) {
        const rowCells = rowMap.get(row) || [];
        rowCells.sort((a, b) => a.col - b.col);
        const cellTexts = rowCells.map(c => `[${c.text.slice(0, 20)}]`).join(" | ");
        console.log(`[DocAnalyst]   row ${row}: ${cellTexts}`);
      }
    }
  }

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

  // 按路径前缀分组（用于识别数组结构）
  const pathGroups = new Map<string, Array<{ path: string; value: string }>>();
  for (const field of flatFields) {
    const pathParts = field.path.split(".");
    // 检查是否为数组路径（如 "申请人或申请团队.0.姓名"）
    const isArrayPath = pathParts.length >= 2 && !isNaN(Number(pathParts[1]));
    const groupKey = isArrayPath ? pathParts[0] : field.path;

    if (!pathGroups.has(groupKey)) pathGroups.set(groupKey, []);
    pathGroups.get(groupKey)!.push(field);
  }

  for (const [groupKey, groupFields] of pathGroups) {
    // 如果是数组路径（如申请人或申请团队.0.姓名）
    if (groupKey !== groupFields[0].path) {
      // 查找表头行
      const headerCell = findHeaderRow(cells, groupKey);
      if (headerCell) {
        // 为数组中的每个元素生成模板
        for (const field of groupFields) {
          const pathParts = field.path.split(".");
          const rowIndex = Number(pathParts[1]);
          const columnName = pathParts[pathParts.length - 1];

          const template = findByArrayTablePositionWithHeader(cells, headerCell, rowIndex, columnName, field.value);
          if (template) {
            templates.push(toTemplate(field.path, field.value, template, 0.82, "matched by repeated table header position"));
          } else {
            failedReasons.push(`No reference position template for field: ${field.path}`);
          }
        }
        continue;
      }
    }

    // 普通路径：使用多种策略匹配
    for (const field of groupFields) {
      // 策略1: 直接文本匹配（置信度 0.96）
      const direct = findCellByText(textCells, field.value);
      if (direct) {
        templates.push(toTemplate(field.path, field.value, direct, 0.96, "matched by reference value text"));
        continue;
      }

      // 策略2: 标签+位置匹配（置信度 0.88）
      const labelBased = findByLabelAndPosition(cells, field.path);
      if (labelBased) {
        templates.push(toTemplate(field.path, field.value, labelBased, 0.88, "matched by reference label neighborhood"));
        continue;
      }

      // 策略3: 数组表格位置匹配（置信度 0.82）
      const tableBased = findByArrayTablePosition(cells, field.path);
      if (tableBased) {
        templates.push(toTemplate(field.path, field.value, tableBased, 0.82, "matched by repeated table header position"));
        continue;
      }

      // 策略4: same-cell key-value 匹配（置信度 0.85）
      const sameCell = findSameCellKeyValue(cells, field.path, field.value);
      if (sameCell) {
        templates.push(toTemplate(field.path, field.value, sameCell, 0.85, "matched by same-cell key-value pattern"));
        continue;
      }

      // 策略5: horizontal multi-pair row 匹配（置信度 0.80）
      const horizontalMulti = findHorizontalMultiPairRow(cells, field.path, field.value);
      if (horizontalMulti) {
        templates.push(toTemplate(field.path, field.value, horizontalMulti, 0.80, "matched by horizontal multi-pair row"));
        continue;
      }

      // 所有策略失败 → 记录失败原因
      failedReasons.push(`No reference position template for field: ${field.path}`);
    }
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

  // 如果是数组，保留数组结构，不要展平
  if (Array.isArray(value)) {
    // 检查是否为对象数组（如团队成员、指导教师）
    if (value.length > 0 && typeof value[0] === "object" && !Array.isArray(value[0])) {
      // 对象数组：为每个对象生成独立的路径
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          for (const [childKey, childValue] of Object.entries(item as Record<string, unknown>)) {
            appendValue(fields, `${path}.${index}.${childKey}`, childValue);
          }
        }
      });
    } else {
      // 基本类型数组：展平为逗号分隔的字符串
      const flatValue = value
        .filter(item => item !== null && item !== undefined)
        .map(item => String(item))
        .join(", ");
      if (flatValue.trim()) {
        fields.push({ path, value: normalizeText(flatValue) });
      }
    }
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

// 新增：same-cell key-value 匹配
function findSameCellKeyValue(
  cells: TableCellRef[],
  fieldPath: string,
  value: string,
): TableCellRef | undefined {
  const keyParts = fieldPath.split(".");
  const key = keyParts[keyParts.length - 1] || fieldPath;
  const canonicalKey = normalizeComparable(key);
  const targetValue = normalizeComparable(value);

  // 查找包含 "key: value" 或 "key：value" 模式的单元格
  return cells.find(cell => {
    const text = normalizeText(cell.text);
    const normalizedText = normalizeComparable(text);

    // 检查是否包含 "key: value" 模式
    const kvPattern = new RegExp(`${escapeRegex(canonicalKey)}[:：]\\s*(.+)`, "i");
    const match = text.match(kvPattern);

    if (match) {
      const cellValue = normalizeComparable(match[1]);
      return cellValue === targetValue || cellValue.includes(targetValue) || targetValue.includes(cellValue);
    }

    // 检查是否包含 "key value" 模式（空格分隔）
    if (normalizedText.includes(canonicalKey)) {
      const afterKey = normalizedText.substring(normalizedText.indexOf(canonicalKey) + canonicalKey.length).trim();
      return afterKey === targetValue || afterKey.includes(targetValue) || targetValue.includes(afterKey);
    }

    return false;
  });
}

// 新增：horizontal multi-pair row 匹配
function findHorizontalMultiPairRow(
  cells: TableCellRef[],
  fieldPath: string,
  value: string,
): TableCellRef | undefined {
  const keyParts = fieldPath.split(".");
  const key = keyParts[keyParts.length - 1] || fieldPath;
  const canonicalKey = normalizeComparable(key);
  const targetValue = normalizeComparable(value);

  // 按行分组
  const rowMap = new Map<number, TableCellRef[]>();
  for (const cell of cells) {
    const row = cell.row;
    if (!rowMap.has(row)) rowMap.set(row, []);
    rowMap.get(row)!.push(cell);
  }

  // 遍历每一行，查找 key-value 对
  for (const [row, rowCells] of rowMap) {
    // 按列排序
    rowCells.sort((a, b) => a.col - b.col);

    // 查找 key 所在的列
    let keyCol = -1;
    for (let i = 0; i < rowCells.length; i++) {
      const cellText = normalizeComparable(rowCells[i].text);
      if (cellText === canonicalKey || cellText.includes(canonicalKey) || canonicalKey.includes(cellText)) {
        keyCol = i;
        break;
      }
    }

    if (keyCol >= 0 && keyCol + 1 < rowCells.length) {
      const valueCell = rowCells[keyCol + 1];
      const cellValue = normalizeComparable(valueCell.text);
      if (cellValue === targetValue || cellValue.includes(targetValue) || targetValue.includes(cellValue)) {
        return valueCell;
      }
    }
  }

  return undefined;
}

// 新增：查找表头行
function findHeaderRow(cells: TableCellRef[], groupName: string): TableCellRef | undefined {
  const canonicalGroupName = normalizeComparable(groupName);

  // 查找包含组名的单元格作为标题行
  return cells.find(cell => {
    const text = normalizeComparable(cell.text);
    return text.includes(canonicalGroupName) || canonicalGroupName.includes(text);
  });
}

// 新增：带表头的数组位置匹配
function findByArrayTablePositionWithHeader(
  cells: TableCellRef[],
  headerCell: TableCellRef,
  rowIndex: number,
  columnName: string,
  value: string,
): TableCellRef | undefined {
  const canonicalColumn = normalizeComparable(columnName);
  const targetValue = normalizeComparable(value);

  // 查找列头
  const headerRow = cells.filter(cell =>
    cell.tableIndex === headerCell.tableIndex &&
    cell.row === headerCell.row
  );

  const columnHeader = headerRow.find(cell => {
    const text = normalizeComparable(cell.text);
    return text === canonicalColumn || text.includes(canonicalColumn) || canonicalColumn.includes(text);
  });

  if (!columnHeader) return undefined;

  // 查找数据行
  const dataRow = headerCell.row + 1 + rowIndex;
  return cells.find(cell =>
    cell.tableIndex === headerCell.tableIndex &&
    cell.row === dataRow &&
    cell.col === columnHeader.col
  );
}

function normalizeComparable(value: string): string {
  return normalizeText(value)
    .replace(/[：:：，,；;。.\s]/g, "")
    .toLowerCase();
}

// 辅助函数：转义正则表达式特殊字符
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
