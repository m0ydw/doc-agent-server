import { randomUUID } from "crypto";
import { parseDocument } from "../docAnalyst/parser";
import type { TableFillAnalysis, ReferenceFieldTemplate, TableCellRef } from "./types";
import { normalizeText, toDocumentTableMap } from "./types";
import { saveTableFillAnalysis } from "./store";

// ================================================================
// 类型定义
// ================================================================

interface TableShape {
  index: number;
  rows: number;
  cols: number;
  cellCount: number;
  avgTextLength: number;
  sampleTexts: string[];
}

interface TableMapping {
  referenceTableIndex: number;
  targetTableIndex: number;
  similarity: number;
  reason: string;
}

interface ColumnDef {
  fieldName: string;
  colIndex: number;
  gridColStart: number;
  gridColEnd: number;
}

interface SectionTemplate {
  sectionName: string;
  tableIndex: number;
  headerRowIndex: number;
  dataStartRowIndex: number;
  dataEndRowIndex: number;
  columns: ColumnDef[];
}

// ================================================================
// 主入口
// ================================================================

export async function analyzeReferenceAndTargetTables(
  referenceDocId: string,
  targetDocId: string,
  userData: Record<string, unknown>,
): Promise<TableFillAnalysis> {
  console.log(`[DocAnalyst] ========== 开始分析参考/目标文档 ==========`);
  console.log(`[DocAnalyst]   referenceDocId: ${referenceDocId}`);
  console.log(`[DocAnalyst]   targetDocId: ${targetDocId}`);

  const referencePayload = await parseDocument(referenceDocId, true);
  const targetPayload = await parseDocument(targetDocId, true);
  const reference = toDocumentTableMap(referencePayload);
  const target = toDocumentTableMap(targetPayload);
  const failedReasons: string[] = [];

  // 打印表格结构
  console.log(`[DocAnalyst] Reference tables=${reference.tables.length}`);
  for (const table of reference.tables) {
    console.log(`[DocAnalyst]   table ${table.index}: ${table.rows} rows x ${table.cols} cols, ${table.cells.length} cells`);
  }
  console.log(`[DocAnalyst] Target tables=${target.tables.length}`);
  for (const table of target.tables) {
    console.log(`[DocAnalyst]   table ${table.index}: ${table.rows} rows x ${table.cols} cols, ${table.cells.length} cells`);
  }

  // 步骤1: 匹配 reference table 到 target table
  const tableMappings = matchTables(reference, target);
  console.log(`[DocAnalyst] Table 映射结果:`);
  for (const mapping of tableMappings) {
    console.log(`[DocAnalyst]   ref table ${mapping.referenceTableIndex} -> target table ${mapping.targetTableIndex} (相似度=${mapping.similarity.toFixed(2)}, ${mapping.reason})`);
  }

  // 步骤2: 从参考文档提取 section 模板
  const sectionTemplates = extractSectionTemplates(reference);
  console.log(`[DocAnalyst] Section 模板提取结果: ${sectionTemplates.length} 个 section`);
  for (const section of sectionTemplates) {
    console.log(`[DocAnalyst]   section "${section.sectionName}": table=${section.tableIndex}, headerRow=${section.headerRowIndex}, dataStart=${section.dataStartRowIndex}, columns=[${section.columns.map(c => `${c.fieldName}(${c.colIndex})`).join(", ")}]`);
  }

  // 步骤3: 提取字段模板
  const templates = buildReferenceTemplates(
    reference.tables.flatMap(table => table.cells),
    userData,
    failedReasons,
    tableMappings,
    sectionTemplates,
    reference,
    target,
  );

  console.log(`[DocAnalyst] Field templates=${templates.length}, failed=${failedReasons.length}`);
  if (templates.length === 0) {
    console.warn(`[DocAnalyst] ⚠️ 未能提取任何字段模板！`);
    for (const reason of failedReasons.slice(0, 10)) {
      console.warn(`[DocAnalyst]   - ${reason}`);
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

// ================================================================
// 步骤1: Table 相似度匹配
// ================================================================

function matchTables(reference: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> }, target: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> }): TableMapping[] {
  const refShapes = reference.tables.map(t => extractTableShape(t));
  const targetShapes = target.tables.map(t => extractTableShape(t));

  const mappings: TableMapping[] = [];
  const usedTargets = new Set<number>();

  for (const refShape of refShapes) {
    let bestMatch: TableMapping | null = null;
    let bestScore = -1;

    for (const targetShape of targetShapes) {
      if (usedTargets.has(targetShape.index)) continue;

      const similarity = calculateTableSimilarity(refShape, targetShape);
      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatch = {
          referenceTableIndex: refShape.index,
          targetTableIndex: targetShape.index,
          similarity,
          reason: `rows=${targetShape.rows}/${refShape.rows}, cols=${targetShape.cols}/${refShape.cols}, cells=${targetShape.cellCount}/${refShape.cellCount}`,
        };
      }
    }

    if (bestMatch) {
      mappings.push(bestMatch);
      usedTargets.add(bestMatch.targetTableIndex);
    }
  }

  return mappings;
}

function extractTableShape(table: { index: number; rows: number; cols: number; cells: TableCellRef[] }): TableShape {
  const texts = table.cells.map(c => c.text).filter(Boolean);
  return {
    index: table.index,
    rows: table.rows,
    cols: table.cols,
    cellCount: table.cells.length,
    avgTextLength: texts.length > 0 ? texts.reduce((sum, t) => sum + t.length, 0) / texts.length : 0,
    sampleTexts: texts.slice(0, 5),
  };
}

function calculateTableSimilarity(ref: TableShape, target: TableShape): number {
  // 行数相似度 (权重 0.3)
  const rowSimilarity = 1 - Math.abs(ref.rows - target.rows) / Math.max(ref.rows, target.rows, 1);

  // 列数相似度 (权重 0.3)
  const colSimilarity = 1 - Math.abs(ref.cols - target.cols) / Math.max(ref.cols, target.cols, 1);

  // cell 数量相似度 (权重 0.2)
  const cellSimilarity = 1 - Math.abs(ref.cellCount - target.cellCount) / Math.max(ref.cellCount, target.cellCount, 1);

  // 平均文本长度相似度 (权重 0.1)
  const textLenSimilarity = ref.avgTextLength > 0 && target.avgTextLength > 0
    ? 1 - Math.abs(ref.avgTextLength - target.avgTextLength) / Math.max(ref.avgTextLength, target.avgTextLength)
    : 0.5;

  // 文本内容重叠度 (权重 0.1)
  const refTexts = new Set(ref.sampleTexts.map(normalizeComparable));
  const targetTexts = new Set(target.sampleTexts.map(normalizeComparable));
  let overlapCount = 0;
  for (const t of refTexts) {
    if (targetTexts.has(t)) overlapCount++;
  }
  const contentSimilarity = refTexts.size > 0 ? overlapCount / refTexts.size : 0.5;

  return rowSimilarity * 0.3 + colSimilarity * 0.3 + cellSimilarity * 0.2 + textLenSimilarity * 0.1 + contentSimilarity * 0.1;
}

// ================================================================
// 步骤2: Section 模板提取
// ================================================================

function extractSectionTemplates(tableMap: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> }): SectionTemplate[] {
  const sections: SectionTemplate[] = [];

  for (const table of tableMap.tables) {
    if (table.rows < 3 || table.cols < 2) continue; // 太小的表格跳过

    // 按行分组
    const rowMap = new Map<number, TableCellRef[]>();
    for (const cell of table.cells) {
      if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
      rowMap.get(cell.row)!.push(cell);
    }

    // 检测 section 边界：找到跨越大部分列的合并单元格（section 标题）
    const sectionHeaders: Array<{ row: number; text: string }> = [];
    for (let row = 0; row < table.rows; row++) {
      const rowCells = rowMap.get(row) || [];
      if (rowCells.length === 0) continue;

      // 检查是否有合并单元格跨越大部分列
      const wideCell = rowCells.find(c => c.colspan >= table.cols * 0.5);
      if (wideCell && wideCell.text) {
        const text = normalizeText(wideCell.text);
        // 排除表头行（如 "角色 | 姓名 | 年级 | ..."）
        const isHeaderRow = rowCells.filter(c => c.text).length >= 3;
        if (!isHeaderRow && text.length > 1) {
          sectionHeaders.push({ row, text });
        }
      }
    }

    // 如果没有检测到 section 辇界，整个表作为一个 section
    if (sectionHeaders.length === 0) {
      // 尝试从第一行提取列定义
      const headerRow = findLikelyHeaderRow(table.cells, table.rows, table.cols);
      if (headerRow !== null) {
        const columns = extractColumnDefs(table.cells, headerRow);
        if (columns.length > 0) {
          sections.push({
            sectionName: `table_${table.index}`,
            tableIndex: table.index,
            headerRowIndex: headerRow,
            dataStartRowIndex: headerRow + 1,
            dataEndRowIndex: table.rows - 1,
            columns,
          });
        }
      }
      continue;
    }

    // 为每个 section 提取列定义
    for (let i = 0; i < sectionHeaders.length; i++) {
      const header = sectionHeaders[i];
      const nextHeaderRow = i + 1 < sectionHeaders.length ? sectionHeaders[i + 1].row : table.rows;
      const dataStartRow = header.row + 1;
      const dataEndRow = nextHeaderRow - 1;

      // 找到 section 内的表头行（通常是 section 标题的下一行）
      const headerRow = findLikelyHeaderRowInSection(table.cells, dataStartRow, dataEndRow);
      const columns = headerRow !== null ? extractColumnDefs(table.cells, headerRow) : [];

      sections.push({
        sectionName: header.text,
        tableIndex: table.index,
        headerRowIndex: headerRow ?? dataStartRow,
        dataStartRowIndex: (headerRow ?? dataStartRow) + 1,
        dataEndRowIndex: dataEndRow,
        columns,
      });
    }
  }

  return sections;
}

function findLikelyHeaderRow(cells: TableCellRef[], tableRows: number, tableCols: number): number | null {
  const rowMap = new Map<number, TableCellRef[]>();
  for (const cell of cells) {
    if (!cell.row) rowMap.set(cell.row, []);
    rowMap.get(cell.row)!.push(cell);
  }

  // 查找第一行有多个短文本的行作为表头
  for (let row = 0; row < Math.min(tableRows, 5); row++) {
    const rowCells = rowMap.get(row) || [];
    const nonEmptyCells = rowCells.filter(c => c.text);
    if (nonEmptyCells.length >= 2) {
      const avgLen = nonEmptyCells.reduce((sum, c) => sum + c.text.length, 0) / nonEmptyCells.length;
      if (avgLen < 15) { // 短文本 = 表头
        return row;
      }
    }
  }
  return null;
}

function findLikelyHeaderRowInSection(cells: TableCellRef[], startRow: number, endRow: number): number | null {
  const rowMap = new Map<number, TableCellRef[]>();
  for (const cell of cells) {
    if (cell.row >= startRow && cell.row <= endRow) {
      if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
      rowMap.get(cell.row)!.push(cell);
    }
  }

  // 在 section 内查找表头行
  for (let row = startRow; row <= Math.min(endRow, startRow + 3); row++) {
    const rowCells = rowMap.get(row) || [];
    const nonEmptyCells = rowCells.filter(c => c.text);
    if (nonEmptyCells.length >= 2) {
      const avgLen = nonEmptyCells.reduce((sum, c) => sum + c.text.length, 0) / nonEmptyCells.length;
      if (avgLen < 15) {
        return row;
      }
    }
  }
  return null;
}

function extractColumnDefs(cells: TableCellRef[], headerRow: number): ColumnDef[] {
  const rowCells = cells.filter(c => c.row === headerRow).sort((a, b) => a.col - b.col);
  const columns: ColumnDef[] = [];

  for (const cell of rowCells) {
    if (cell.text) {
      columns.push({
        fieldName: normalizeText(cell.text),
        colIndex: cell.col,
        gridColStart: cell.col,
        gridColEnd: cell.col + cell.colspan,
      });
    }
  }

  return columns;
}

// ================================================================
// 步骤3: 字段模板提取
// ================================================================

function buildReferenceTemplates(
  cells: TableCellRef[],
  userData: Record<string, unknown>,
  failedReasons: string[],
  tableMappings: TableMapping[],
  sectionTemplates: SectionTemplate[],
  reference: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> },
  target: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> },
): ReferenceFieldTemplate[] {
  const templates: ReferenceFieldTemplate[] = [];
  const textCells = cells.filter(cell => normalizeText(cell.text));
  const flatFields = flattenUserData(userData);

  console.log(`[DocAnalyst] 开始模板匹配，共 ${flatFields.length} 个字段`);

  // 构建 tableMapping 查找表
  const tableMappingByRef = new Map<number, number>();
  for (const mapping of tableMappings) {
    tableMappingByRef.set(mapping.referenceTableIndex, mapping.targetTableIndex);
  }

  // 按路径前缀分组
  const pathGroups = new Map<string, Array<{ path: string; value: string }>>();
  for (const field of flatFields) {
    const pathParts = field.path.split(".");
    const isArrayPath = pathParts.length >= 2 && !isNaN(Number(pathParts[1]));
    const groupKey = isArrayPath ? pathParts[0] : field.path;

    if (!pathGroups.has(groupKey)) pathGroups.set(groupKey, []);
    pathGroups.get(groupKey)!.push(field);
  }

  console.log(`[DocAnalyst] 字段分组完成，共 ${pathGroups.size} 组`);

  for (const [groupKey, groupFields] of pathGroups) {
    // 数组路径处理
    if (groupKey !== groupFields[0].path) {
      processArrayGroup(groupKey, groupFields, cells, templates, failedReasons, sectionTemplates, tableMappingByRef);
      continue;
    }

    // 普通路径处理
    for (const field of groupFields) {
      processSimpleField(field, cells, textCells, templates, failedReasons, tableMappingByRef);
    }
  }

  return templates;
}

// ================================================================
// 普通字段处理
// ================================================================

function processSimpleField(
  field: { path: string; value: string },
  cells: TableCellRef[],
  textCells: TableCellRef[],
  templates: ReferenceFieldTemplate[],
  failedReasons: string[],
  tableMappingByRef: Map<number, number>,
): void {
  // 策略1: 直接文本匹配（置信度 0.96）
  const direct = findCellByText(textCells, field.value);
  if (direct) {
    const mappedTable = tableMappingByRef.get(direct.tableIndex) ?? direct.tableIndex;
    console.log(`[DocAnalyst] 直接文本匹配: ${field.path} -> ref table=${direct.tableIndex} -> target table=${mappedTable}, row=${direct.row}, col=${direct.col}`);
    templates.push(toTemplate(field.path, field.value, direct, mappedTable, 0.96, "matched by reference value text"));
    return;
  }

  // 策略2: 标签+位置匹配（置信度 0.88）
  const labelBased = findByLabelAndPosition(cells, field.path);
  if (labelBased) {
    const mappedTable = tableMappingByRef.get(labelBased.tableIndex) ?? labelBased.tableIndex;
    console.log(`[DocAnalyst] 标签位置匹配: ${field.path} -> ref table=${labelBased.tableIndex} -> target table=${mappedTable}, row=${labelBased.row}, col=${labelBased.col}`);
    templates.push(toTemplate(field.path, field.value, labelBased, mappedTable, 0.88, "matched by reference label neighborhood"));
    return;
  }

  // 策略3: same-cell key-value 匹配（置信度 0.85）
  const sameCell = findSameCellKeyValue(cells, field.path, field.value);
  if (sameCell) {
    const mappedTable = tableMappingByRef.get(sameCell.tableIndex) ?? sameCell.tableIndex;
    console.log(`[DocAnalyst] same-cell 匹配: ${field.path} -> ref table=${sameCell.tableIndex} -> target table=${mappedTable}, row=${sameCell.row}, col=${sameCell.col}`);
    templates.push(toTemplate(field.path, field.value, sameCell, mappedTable, 0.85, "matched by same-cell key-value pattern"));
    return;
  }

  // 策略4: horizontal multi-pair row 匹配（置信度 0.80）
  const horizontalMulti = findHorizontalMultiPairRow(cells, field.path, field.value);
  if (horizontalMulti) {
    const mappedTable = tableMappingByRef.get(horizontalMulti.tableIndex) ?? horizontalMulti.tableIndex;
    console.log(`[DocAnalyst] 水平多对匹配: ${field.path} -> ref table=${horizontalMulti.tableIndex} -> target table=${mappedTable}, row=${horizontalMulti.row}, col=${horizontalMulti.col}`);
    templates.push(toTemplate(field.path, field.value, horizontalMulti, mappedTable, 0.80, "matched by horizontal multi-pair row"));
    return;
  }

  console.warn(`[DocAnalyst] ⚠️ 所有匹配策略失败: ${field.path}`);
  failedReasons.push(`No reference position template for field: ${field.path}`);
}

// ================================================================
// 数组字段处理
// ================================================================

function processArrayGroup(
  groupKey: string,
  groupFields: Array<{ path: string; value: string }>,
  cells: TableCellRef[],
  templates: ReferenceFieldTemplate[],
  failedReasons: string[],
  sectionTemplates: SectionTemplate[],
  tableMappingByRef: Map<number, number>,
): void {
  console.log(`[DocAnalyst] 处理数组组: ${groupKey} (${groupFields.length} 个字段)`);

  // 尝试匹配 section 模板
  const section = findMatchingSection(groupKey, sectionTemplates);
  if (section) {
    console.log(`[DocAnalyst] 匹配到 section: "${section.sectionName}" (table=${section.tableIndex}, headerRow=${section.headerRowIndex}, dataStart=${section.dataStartRowIndex})`);
    processArrayGroupWithSection(groupKey, groupFields, section, templates, failedReasons, tableMappingByRef);
    return;
  }

  // Fallback: 使用旧的表头匹配逻辑
  console.log(`[DocAnalyst] 未匹配到 section，使用 fallback 表头匹配`);
  const headerCell = findHeaderRow(cells, groupKey);
  if (headerCell) {
    processArrayGroupWithHeader(groupKey, groupFields, cells, headerCell, templates, failedReasons, tableMappingByRef);
    return;
  }

  console.warn(`[DocAnalyst] ⚠️ 未找到表头: ${groupKey}`);
  for (const field of groupFields) {
    failedReasons.push(`No reference position template for field: ${field.path}`);
  }
}

function findMatchingSection(groupKey: string, sectionTemplates: SectionTemplate[]): SectionTemplate | null {
  const canonicalKey = normalizeComparable(groupKey);

  // 精确匹配
  for (const section of sectionTemplates) {
    if (normalizeComparable(section.sectionName) === canonicalKey) {
      return section;
    }
  }

  // 模糊匹配
  for (const section of sectionTemplates) {
    const sectionName = normalizeComparable(section.sectionName);
    if (sectionName.includes(canonicalKey) || canonicalKey.includes(sectionName)) {
      return section;
    }
  }

  return null;
}

function processArrayGroupWithSection(
  groupKey: string,
  groupFields: Array<{ path: string; value: string }>,
  section: SectionTemplate,
  templates: ReferenceFieldTemplate[],
  failedReasons: string[],
  tableMappingByRef: Map<number, number>,
): void {
  const mappedTable = tableMappingByRef.get(section.tableIndex) ?? section.tableIndex;

  for (const field of groupFields) {
    const pathParts = field.path.split(".");
    const rowIndex = Number(pathParts[1]);
    const columnName = pathParts[pathParts.length - 1];

    // 在 section 的列定义中查找列
    const column = findMatchingColumn(columnName, section.columns);
    if (column) {
      const targetRow = section.dataStartRowIndex + rowIndex;
      const targetCol = column.colIndex;
      console.log(`[DocAnalyst] section 列映射: ${field.path} -> ref table=${section.tableIndex} -> target table=${mappedTable}, row=${targetRow}, col=${targetCol} (列 "${column.fieldName}")`);

      // 创建一个虚拟的 cell 用于模板
      const virtualCell: TableCellRef = {
        tableIndex: section.tableIndex,
        row: targetRow,
        col: targetCol,
        ref: `virtual_${field.path}`,
        nodeId: `virtual_${field.path}`,
        text: field.value,
        rowspan: 1,
        colspan: 1,
        gridColEnd: targetCol + 1,
      };

      templates.push(toTemplate(field.path, field.value, virtualCell, mappedTable, 0.82, `matched by section "${section.sectionName}" column "${column.fieldName}"`));
    } else {
      console.warn(`[DocAnalyst] ⚠️ 未找到列: ${columnName} in section "${section.sectionName}"`);
      failedReasons.push(`No column match for field: ${field.path} in section "${section.sectionName}"`);
    }
  }
}

function findMatchingColumn(columnName: string, columns: ColumnDef[]): ColumnDef | null {
  const canonicalName = normalizeComparable(columnName);

  // 精确匹配
  for (const col of columns) {
    if (normalizeComparable(col.fieldName) === canonicalName) {
      return col;
    }
  }

  // 模糊匹配
  for (const col of columns) {
    const colName = normalizeComparable(col.fieldName);
    if (colName.includes(canonicalName) || canonicalName.includes(colName)) {
      return col;
    }
  }

  // 同义词匹配
  const synonyms: Record<string, string[]> = {
    "email": ["e-mail", "邮箱", "电子邮箱"],
    "phone": ["手机", "电话", "联系电话"],
    "name": ["姓名"],
    "role": ["角色"],
    "grade": ["年级"],
    "school": ["学校"],
    "department": ["院系", "专业", "所在院系/专业"],
    "age": ["年龄"],
    "research": ["研究方向"],
    "position": ["职务", "行政职务", "专业技术职务", "行政职务/专业技术职务"],
  };

  for (const [key, syns] of Object.entries(synonyms)) {
    if (normalizeComparable(key) === canonicalName || syns.some(s => normalizeComparable(s) === canonicalName)) {
      for (const col of columns) {
        const colName = normalizeComparable(col.fieldName);
        if (colName === key || syns.some(s => normalizeComparable(s) === colName)) {
          return col;
        }
      }
    }
  }

  return null;
}

function processArrayGroupWithHeader(
  groupKey: string,
  groupFields: Array<{ path: string; value: string }>,
  cells: TableCellRef[],
  headerCell: TableCellRef,
  templates: ReferenceFieldTemplate[],
  failedReasons: string[],
  tableMappingByRef: Map<number, number>,
): void {
  const mappedTable = tableMappingByRef.get(headerCell.tableIndex) ?? headerCell.tableIndex;
  console.log(`[DocAnalyst] 表头匹配: headerRow=${headerCell.row}, col=${headerCell.col}, text="${headerCell.text}"`);

  for (const field of groupFields) {
    const pathParts = field.path.split(".");
    const rowIndex = Number(pathParts[1]);
    const columnName = pathParts[pathParts.length - 1];

    const template = findByArrayTablePositionWithHeader(cells, headerCell, rowIndex, columnName, field.value);
    if (template) {
      const cellMappedTable = tableMappingByRef.get(template.tableIndex) ?? template.tableIndex;
      console.log(`[DocAnalyst] 数组字段匹配: ${field.path} -> ref table=${template.tableIndex} -> target table=${cellMappedTable}, row=${template.row}, col=${template.col}`);
      templates.push(toTemplate(field.path, field.value, template, cellMappedTable, 0.82, "matched by repeated table header position"));
    } else {
      console.warn(`[DocAnalyst] ⚠️ 数组字段匹配失败: ${field.path}`);
      failedReasons.push(`No reference position template for field: ${field.path}`);
    }
  }
}

// ================================================================
// 辅助函数
// ================================================================

function toTemplate(
  fieldPath: string,
  value: string,
  cell: TableCellRef,
  targetTableIndex: number,
  confidence: number,
  reason: string,
): ReferenceFieldTemplate {
  return {
    fieldPath,
    value,
    tableIndex: targetTableIndex, // 使用映射后的 target tableIndex
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
    if (value.length > 0 && typeof value[0] === "object" && !Array.isArray(value[0])) {
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          for (const [childKey, childValue] of Object.entries(item as Record<string, unknown>)) {
            appendValue(fields, `${path}.${index}.${childKey}`, childValue);
          }
        }
      });
    } else {
      const flatValue = value.filter(item => item != null).map(item => String(item)).join(", ");
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

  // 右侧 cell
  const rightCells = sameTable
    .filter(cell => cell.row === label.row && cell.col > label.col)
    .sort((a, b) => a.col - b.col);

  for (const rightCell of rightCells) {
    if (!isLikelyLabelCell(rightCell)) {
      return rightCell;
    }
  }

  // 下方 cell
  const belowCells = sameTable
    .filter(cell => cell.col === label.col && cell.row > label.row)
    .sort((a, b) => a.row - b.row);

  for (const belowCell of belowCells) {
    if (!isLikelyLabelCell(belowCell)) {
      return belowCell;
    }
  }

  return undefined;
}

function isLikelyLabelCell(cell: TableCellRef): boolean {
  const text = normalizeText(cell.text);
  if (!text) return false;
  if (text.length < 20) {
    if (text.endsWith(":") || text.endsWith("：")) return true;
    const normalizedText = normalizeComparable(text);
    const commonLabels = ["项目名称", "项目类型", "项目负责人", "申报日期", "申请人", "指导教师", "姓名", "年龄", "研究方向", "职务", "手机", "邮箱", "电话", "角色", "年级", "学校", "院系", "专业"];
    for (const label of commonLabels) {
      if (normalizedText.includes(normalizeComparable(label))) return true;
    }
  }
  return false;
}

function findSameCellKeyValue(cells: TableCellRef[], fieldPath: string, value: string): TableCellRef | undefined {
  const keyParts = fieldPath.split(".");
  const key = keyParts[keyParts.length - 1] || fieldPath;
  const canonicalKey = normalizeComparable(key);
  const targetValue = normalizeComparable(value);

  return cells.find(cell => {
    const text = normalizeText(cell.text);
    const normalizedText = normalizeComparable(text);

    const kvPattern = new RegExp(`${escapeRegex(canonicalKey)}[:：]\\s*(.+)`, "i");
    const match = text.match(kvPattern);

    if (match) {
      const cellValue = normalizeComparable(match[1]);
      return cellValue === targetValue || cellValue.includes(targetValue) || targetValue.includes(cellValue);
    }

    if (normalizedText.includes(canonicalKey)) {
      const afterKey = normalizedText.substring(normalizedText.indexOf(canonicalKey) + canonicalKey.length).trim();
      return afterKey === targetValue || afterKey.includes(targetValue) || targetValue.includes(afterKey);
    }

    return false;
  });
}

function findHorizontalMultiPairRow(cells: TableCellRef[], fieldPath: string, value: string): TableCellRef | undefined {
  const keyParts = fieldPath.split(".");
  const key = keyParts[keyParts.length - 1] || fieldPath;
  const canonicalKey = normalizeComparable(key);
  const targetValue = normalizeComparable(value);

  const rowMap = new Map<number, TableCellRef[]>();
  for (const cell of cells) {
    const row = cell.row;
    if (!rowMap.has(row)) rowMap.set(row, []);
    rowMap.get(row)!.push(cell);
  }

  for (const [row, rowCells] of rowMap) {
    rowCells.sort((a, b) => a.col - b.col);

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

function findHeaderRow(cells: TableCellRef[], groupName: string): TableCellRef | undefined {
  const canonicalGroupName = normalizeComparable(groupName);

  return cells.find(cell => {
    const text = normalizeComparable(cell.text);
    return text.includes(canonicalGroupName) || canonicalGroupName.includes(text);
  });
}

function findByArrayTablePositionWithHeader(
  cells: TableCellRef[],
  headerCell: TableCellRef,
  rowIndex: number,
  columnName: string,
  value: string,
): TableCellRef | undefined {
  const canonicalColumn = normalizeComparable(columnName);

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

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
