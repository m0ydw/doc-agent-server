import { randomUUID } from "crypto";
import { parseDocument } from "../docAnalyst/parser";
import type {
  DuplicateTemplateGroup,
  TableFillAnalysis,
  ReferenceFieldTemplate,
  TableCellRef,
} from "./types";
import { normalizeText, toDocumentTableMap } from "./types";
import { saveTableFillAnalysis } from "./store";

type TableRole = "key_value_table" | "section_table" | "unknown";

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
  nodeId: string;
}

interface SectionTemplate {
  sectionName: string;
  tableIndex: number;
  sectionHeaderRowIndex: number;
  columnHeaderRowIndex: number;
  headerRowIndex: number;
  dataStartRowIndex: number;
  dataEndRowIndex: number;
  columns: ColumnDef[];
}

interface FailedSection {
  sectionName: string;
  tableIndex: number;
  reason: string;
}

interface RowInfo {
  row: number;
  cells: TableCellRef[];
  nonEmptyCells: TableCellRef[];
  texts: string[];
}

const ARRAY_SECTION_NAMES = ["申请人或申请团队", "指导教师"];
const BASIC_FIELD_NAMES = ["项目名称", "项目类型", "项目负责人", "申报日期"];

const APPLICANT_COLUMNS = ["角色", "姓名", "年级", "学校", "所在院系/专业", "联系电话", "E-mail"];
const TEACHER_COLUMNS = ["姓名", "年龄", "研究方向", "行政职务/专业技术职务", "手机", "电子邮箱"];

export async function analyzeReferenceAndTargetTables(
  referenceDocId: string,
  targetDocId: string,
  userData: Record<string, unknown>,
): Promise<TableFillAnalysis> {
  console.log("[DocAnalyst] ========== 开始分析参考/目标文档 ==========");
  console.log(`[DocAnalyst]   referenceDocId: ${referenceDocId}`);
  console.log(`[DocAnalyst]   targetDocId: ${targetDocId}`);

  const referencePayload = await parseDocument(referenceDocId, true);
  const targetPayload = await parseDocument(targetDocId, true);
  const reference = toDocumentTableMap(referencePayload);
  const target = toDocumentTableMap(targetPayload);
  const failedReasons: string[] = [];

  logTableSummary("Reference", reference.tables);
  logTableSummary("Target", target.tables);
  const sanity = validateReferenceTextSanity(reference);
  if (!sanity.ok) {
    for (const reason of sanity.failedReasons) {
      failedReasons.push(reason);
      console.error(`[DocAnalyst] Text sanity check failed: ${reason}`);
    }
  }

  const tableMappings = matchTables(reference, target);
  console.log("[DocAnalyst] Table 映射结果:");
  for (const mapping of tableMappings) {
    console.log(`[DocAnalyst]   ref table ${mapping.referenceTableIndex} -> target table ${mapping.targetTableIndex} (similarity=${mapping.similarity.toFixed(2)}, ${mapping.reason})`);
  }

  for (const table of reference.tables) {
    if (classifyTableRole(table) === "section_table") {
      dumpTableMatrix(table);
    }
  }

  const { sections: sectionTemplates, failedSections } = extractSectionTemplates(reference);
  console.log(`[DocAnalyst] Section 模板提取结果: ${sectionTemplates.length} 个 section`);
  for (const section of sectionTemplates) {
    console.log(`[DocAnalyst]   section "${section.sectionName}": table=${section.tableIndex}, sectionHeader=${section.sectionHeaderRowIndex}, columnHeader=${section.columnHeaderRowIndex}, dataStart=${section.dataStartRowIndex}, columns=[${section.columns.map(c => `${c.fieldName}(${c.colIndex})`).join(", ")}]`);
  }

  const { templates, missingSections } = buildReferenceTemplates(
    reference.tables.flatMap(table => table.cells),
    userData,
    failedReasons,
    tableMappings,
    sectionTemplates,
    reference,
  );

  const duplicateTemplateGroups = detectDuplicateTemplates(templates);
  for (const duplicate of duplicateTemplateGroups) {
    failedReasons.push(`Duplicate template target ${duplicate.targetKey}: ${duplicate.fieldPaths.join(", ")}`);
  }

  console.log(`[DocAnalyst] Field templates=${templates.length}, failed=${failedReasons.length}, duplicates=${duplicateTemplateGroups.length}`);

  const analysis: TableFillAnalysis = {
    analysisId: `table_fill_${randomUUID()}`,
    referenceDocId,
    targetDocId,
    reference,
    target,
    templates,
    failedReasons,
    failedSections,
    missingSections,
    duplicateTemplateGroups,
    createdAt: new Date().toISOString(),
  };

  saveTableFillAnalysis(analysis);
  return analysis;
}

function logTableSummary(label: string, tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }>): void {
  console.log(`[DocAnalyst] ${label} tables=${tables.length}`);
  for (const table of tables) {
    console.log(`[DocAnalyst]   table ${table.index}: ${table.rows} rows x ${table.cols} cols, ${table.cells.length} cells, role=${classifyTableRole(table)}`);
  }
}

function validateReferenceTextSanity(reference: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> }): { ok: boolean; failedReasons: string[] } {
  const table1 = reference.tables.find(table => table.index === 1);
  const failedReasons: string[] = [];
  if (!table1) {
    return { ok: false, failedReasons: ["REFERENCE_TABLE_1_NOT_FOUND"] };
  }

  const nonEmptyCellCount = table1.cells.filter(cell => normalizeText(cell.text)).length;
  if (nonEmptyCellCount === 0) {
    failedReasons.push("REFERENCE_TABLE_1_TEXT_EXTRACTION_EMPTY");
  }

  const allText = normalizeComparable(table1.cells.map(cell => cell.text).join(" "));
  const requiredTerms = [
    "申请人或申请团队",
    "指导教师",
    "项目名称",
    "姓名",
    "年级",
    "学校",
    "联系电话",
    "email",
  ];

  for (const term of requiredTerms) {
    if (!allText.includes(normalizeComparable(term))) {
      failedReasons.push(`REFERENCE_TEXT_MISSING:${term}`);
    }
  }

  return { ok: failedReasons.length === 0, failedReasons };
}

function dumpTableMatrix(table: { index: number; rows: number; cols: number; cells: TableCellRef[] }): void {
  const rows = buildRows(table.cells);
  console.log(`[DocAnalyst] Table ${table.index} matrix dump:`);
  for (let row = 0; row < table.rows; row++) {
    const info = rows.get(row) || { row, cells: [], nonEmptyCells: [], texts: [] };
    const textLine = Array.from({ length: table.cols }, (_, col) => {
      const cell = info.cells.find(c => c.col === col);
      return normalizeText(cell?.text || "");
    }).join(" | ");
    const gridLine = info.cells
      .sort((a, b) => a.col - b.col)
      .map(cell => `[${cell.col}-${cell.gridColEnd}] "${normalizeText(cell.text)}"`)
      .join(", ");
    console.log(`[DocAnalyst]   row ${row}: ${textLine}`);
    console.log(`[DocAnalyst]     nonEmpty=${info.nonEmptyCells.length}, texts=[${info.texts.join(", ")}], grid=${gridLine}`);
  }
}

function matchTables(
  reference: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> },
  target: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> },
): TableMapping[] {
  const mappings: TableMapping[] = [];
  const usedTargets = new Set<number>();

  for (const refTable of reference.tables) {
    let best: TableMapping | null = null;
    let bestScore = -1;
    for (const targetTable of target.tables) {
      if (usedTargets.has(targetTable.index)) continue;
      const score = calculateTableSimilarity(refTable, targetTable);
      if (score > bestScore) {
        bestScore = score;
        best = {
          referenceTableIndex: refTable.index,
          targetTableIndex: targetTable.index,
          similarity: score,
          reason: `rows=${targetTable.rows}/${refTable.rows}, cols=${targetTable.cols}/${refTable.cols}, cells=${targetTable.cells.length}/${refTable.cells.length}`,
        };
      }
    }

    if (best) {
      mappings.push(best);
      usedTargets.add(best.targetTableIndex);
    }
  }

  return mappings;
}

function calculateTableSimilarity(
  ref: { rows: number; cols: number; cells: TableCellRef[] },
  target: { rows: number; cols: number; cells: TableCellRef[] },
): number {
  const rowSimilarity = 1 - Math.abs(ref.rows - target.rows) / Math.max(ref.rows, target.rows, 1);
  const colSimilarity = 1 - Math.abs(ref.cols - target.cols) / Math.max(ref.cols, target.cols, 1);
  const cellSimilarity = 1 - Math.abs(ref.cells.length - target.cells.length) / Math.max(ref.cells.length, target.cells.length, 1);
  const roleSimilarity = classifyTableRole(ref) === classifyTableRole(target) ? 1 : 0;
  return rowSimilarity * 0.35 + colSimilarity * 0.35 + cellSimilarity * 0.2 + roleSimilarity * 0.1;
}

function classifyTableRole(table: { rows: number; cols: number; cells: TableCellRef[] }): TableRole {
  if (table.cols <= 3 && table.rows <= 10) return "key_value_table";
  if (table.cols >= 5 && table.rows >= 6) return "section_table";
  return "unknown";
}

function extractSectionTemplates(tableMap: { tables?: Array<{ index: number; rows: number; cols: number; cells?: TableCellRef[] }> }): { sections: SectionTemplate[]; failedSections: FailedSection[] } {
  const sections: SectionTemplate[] = [];
  const failedSections: FailedSection[] = [];

  for (const table of tableMap.tables ?? []) {
    if (!table || !Array.isArray(table.cells)) {
      failedSections.push({ sectionName: `table_${table?.index ?? "unknown"}`, tableIndex: table?.index ?? -1, reason: "INVALID_TABLE_CELLS" });
      continue;
    }

    if (classifyTableRole({ ...table, cells: table.cells }) !== "section_table") {
      continue;
    }

    const concreteTable = { ...table, cells: table.cells };
    const rows = buildRows(concreteTable.cells);
    const candidates = findSectionHeaderCandidates(concreteTable, rows);
    if (candidates.length === 0) {
      failedSections.push({ sectionName: `table_${table.index}`, tableIndex: table.index, reason: "SECTION_TEMPLATE_NOT_FOUND" });
      continue;
    }

    const sorted = candidates.sort((a, b) => a.columnHeaderRowIndex - b.columnHeaderRowIndex);
    for (let index = 0; index < sorted.length; index++) {
      const current = sorted[index];
      const next = sorted[index + 1];
      const columns = extractColumnDefs(table.cells, current.columnHeaderRowIndex);
      if (columns.length === 0) {
        failedSections.push({ sectionName: current.sectionName, tableIndex: table.index, reason: "HEADER_COLUMNS_NOT_FOUND" });
        continue;
      }

      sections.push({
        sectionName: current.sectionName,
        tableIndex: table.index,
        sectionHeaderRowIndex: current.sectionHeaderRowIndex,
        columnHeaderRowIndex: current.columnHeaderRowIndex,
        headerRowIndex: current.columnHeaderRowIndex,
        dataStartRowIndex: current.columnHeaderRowIndex + 1,
        dataEndRowIndex: next ? Math.max(current.columnHeaderRowIndex + 1, next.sectionHeaderRowIndex - 1) : table.rows - 1,
        columns,
      });
    }
  }

  return { sections, failedSections };
}

function findSectionHeaderCandidates(
  table: { index: number; rows: number; cols: number; cells: TableCellRef[] },
  rows: Map<number, RowInfo>,
): Array<{ sectionName: string; sectionHeaderRowIndex: number; columnHeaderRowIndex: number; score: number }> {
  const bestBySection = new Map<string, { sectionName: string; sectionHeaderRowIndex: number; columnHeaderRowIndex: number; score: number }>();

  for (let row = 0; row < table.rows; row++) {
    const info = rows.get(row);
    if (!info || info.nonEmptyCells.length === 0) continue;

    const applicantScore = countHeaderMatches(info.texts, APPLICANT_COLUMNS);
    const teacherScore = countHeaderMatches(info.texts, TEACHER_COLUMNS);
    const candidates: Array<{ sectionName: string; score: number }> = [];
    if (applicantScore >= 3) candidates.push({ sectionName: "申请人或申请团队", score: applicantScore });
    if (teacherScore >= 3) candidates.push({ sectionName: "指导教师", score: teacherScore });

    for (const candidate of candidates) {
      const sectionHeaderRowIndex = findSectionTitleRow(rows, row, candidate.sectionName);
      const existing = bestBySection.get(candidate.sectionName);
      if (!existing || candidate.score > existing.score) {
        bestBySection.set(candidate.sectionName, {
          sectionName: candidate.sectionName,
          sectionHeaderRowIndex,
          columnHeaderRowIndex: row,
          score: candidate.score,
        });
      }
    }
  }

  return [...bestBySection.values()];
}

function findSectionTitleRow(rows: Map<number, RowInfo>, headerRow: number, sectionName: string): number {
  const wanted = normalizeComparable(sectionName);
  for (let row = headerRow - 1; row >= Math.max(0, headerRow - 4); row--) {
    const info = rows.get(row);
    if (!info || info.nonEmptyCells.length === 0) continue;
    const joined = normalizeComparable(info.texts.join(""));
    if (joined.includes(wanted) || wanted.includes(joined)) return row;
    if (info.nonEmptyCells.length <= 2) return row;
  }
  return Math.max(0, headerRow - 1);
}

function findLikelyHeaderRow(cells: TableCellRef[] | undefined, tableRows: number, tableCols: number): number | null {
  if (!Array.isArray(cells) || cells.length === 0 || tableRows <= 0 || tableCols <= 0) return null;
  const rows = buildRows(cells);
  for (let row = 0; row < Math.min(tableRows, 5); row++) {
    const info = rows.get(row);
    if (!info || info.nonEmptyCells.length === 0) continue;
    if (info.nonEmptyCells.length >= 2 && averageTextLength(info.nonEmptyCells) < 15) return row;
  }
  return null;
}

function findLikelyHeaderRowInSection(cells: TableCellRef[] | undefined, startRow: number, endRow: number): number | null {
  if (!Array.isArray(cells) || cells.length === 0 || startRow > endRow) return null;
  const rows = buildRows(cells);
  for (let row = startRow; row <= Math.min(endRow, startRow + 3); row++) {
    const info = rows.get(row);
    if (!info || info.nonEmptyCells.length === 0) continue;
    if (info.nonEmptyCells.length >= 2 && averageTextLength(info.nonEmptyCells) < 15) return row;
  }
  return null;
}

function extractColumnDefs(cells: TableCellRef[], headerRow: number): ColumnDef[] {
  return cells
    .filter(cell => cell.row === headerRow && normalizeText(cell.text))
    .sort((a, b) => a.col - b.col)
    .map(cell => ({
      fieldName: normalizeText(cell.text),
      colIndex: cell.col,
      gridColStart: cell.col,
      gridColEnd: cell.gridColEnd,
      nodeId: cell.nodeId,
    }));
}

function buildReferenceTemplates(
  cells: TableCellRef[],
  userData: Record<string, unknown>,
  failedReasons: string[],
  tableMappings: TableMapping[],
  sectionTemplates: SectionTemplate[],
  reference: { tables: Array<{ index: number; rows: number; cols: number; cells: TableCellRef[] }> },
): { templates: ReferenceFieldTemplate[]; missingSections: string[] } {
  const templates: ReferenceFieldTemplate[] = [];
  const missingSections: string[] = [];
  const flatFields = flattenUserData(userData);
  const tableMappingByRef = new Map(tableMappings.map(mapping => [mapping.referenceTableIndex, mapping.targetTableIndex]));
  const tableRoles = new Map(reference.tables.map(table => [table.index, classifyTableRole(table)]));
  const pathGroups = groupFields(flatFields);

  console.log(`[DocAnalyst] 开始模板匹配，共 ${flatFields.length} 个字段，${pathGroups.size} 个分组`);

  for (const [groupKey, groupFields] of pathGroups) {
    const isArrayGroup = groupKey !== groupFields[0].path;
    if (isArrayGroup) {
      const section = findMatchingSection(groupKey, sectionTemplates);
      if (!section) {
        console.warn(`[DocAnalyst] 未找到 section 模板: ${groupKey}`);
        missingSections.push(groupKey);
        for (const field of groupFields) failedReasons.push(`SECTION_TEMPLATE_NOT_FOUND for field: ${field.path}`);
        continue;
      }
      processArrayGroupWithSection(groupFields, section, cells, templates, failedReasons, tableMappingByRef);
      continue;
    }

    for (const field of groupFields) {
      processSimpleField(field, cells, templates, failedReasons, tableMappingByRef, tableRoles);
    }
  }

  return { templates, missingSections: [...new Set(missingSections)] };
}

function groupFields(fields: Array<{ path: string; value: string }>): Map<string, Array<{ path: string; value: string }>> {
  const groups = new Map<string, Array<{ path: string; value: string }>>();
  for (const field of fields) {
    const parts = field.path.split(".");
    const isArrayPath = parts.length >= 2 && Number.isFinite(Number(parts[1]));
    const key = isArrayPath ? parts[0] : field.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(field);
  }
  return groups;
}

function processSimpleField(
  field: { path: string; value: string },
  cells: TableCellRef[],
  templates: ReferenceFieldTemplate[],
  failedReasons: string[],
  tableMappingByRef: Map<number, number>,
  tableRoles: Map<number, TableRole>,
): void {
  const basicCells = cells.filter(cell => tableRoles.get(cell.tableIndex) === "key_value_table");
  const strategies = [
    () => findByLabelAndPosition(basicCells, field.path),
    () => findSameCellKeyValue(basicCells, field.path),
    () => findHorizontalMultiPairRow(basicCells, field.path),
  ];

  for (const strategy of strategies) {
    const match = strategy();
    if (match) {
      const targetTable = tableMappingByRef.get(match.tableIndex) ?? match.tableIndex;
      templates.push(toTemplate(field.path, field.value, match, targetTable, 0.9, "matched by key-value table layout"));
      return;
    }
  }

  failedReasons.push(`No key-value table template for field: ${field.path}`);
}

function processArrayGroupWithSection(
  groupFields: Array<{ path: string; value: string }>,
  section: SectionTemplate,
  cells: TableCellRef[],
  templates: ReferenceFieldTemplate[],
  failedReasons: string[],
  tableMappingByRef: Map<number, number>,
): void {
  const mappedTable = tableMappingByRef.get(section.tableIndex) ?? section.tableIndex;
  console.log(`[DocAnalyst] 匹配到 section: "${section.sectionName}" (table=${section.tableIndex}, headerRow=${section.columnHeaderRowIndex}, dataStart=${section.dataStartRowIndex})`);

  for (const field of groupFields) {
    const parts = field.path.split(".");
    const rowOffset = Number(parts[1]);
    const columnName = parts[parts.length - 1];
    if (!Number.isFinite(rowOffset)) {
      failedReasons.push(`Invalid array row index for field: ${field.path}`);
      continue;
    }

    const column = findMatchingColumn(columnName, section.columns);
    if (!column) {
      failedReasons.push(`No column match for field: ${field.path} in section "${section.sectionName}"`);
      continue;
    }

    const row = section.dataStartRowIndex + rowOffset;
    if (row > section.dataEndRowIndex) {
      failedReasons.push(`No data row for field: ${field.path} in section "${section.sectionName}"`);
      continue;
    }

    const referenceCell = findCellAt(cells, section.tableIndex, row, column.colIndex) || {
      tableIndex: section.tableIndex,
      row,
      col: column.colIndex,
      ref: `virtual_${field.path}`,
      nodeId: column.nodeId,
      text: field.value,
      rowspan: 1,
      colspan: 1,
      gridColEnd: column.gridColEnd,
    };

    templates.push(toTemplate(field.path, field.value, referenceCell, mappedTable, 0.92, `matched by section "${section.sectionName}" column "${column.fieldName}"`));
  }
}

function findMatchingSection(groupKey: string, sections: SectionTemplate[]): SectionTemplate | null {
  const wanted = normalizeComparable(groupKey);
  return sections.find(section => {
    const name = normalizeComparable(section.sectionName);
    return name === wanted || name.includes(wanted) || wanted.includes(name);
  }) || null;
}

function findMatchingColumn(columnName: string, columns: ColumnDef[]): ColumnDef | null {
  const wanted = normalizeComparable(columnName);
  const aliases = columnAliases(columnName).map(normalizeComparable);
  return columns.find(column => {
    const actual = normalizeComparable(column.fieldName);
    return actual === wanted
      || aliases.includes(actual)
      || aliases.some(alias => actual.includes(alias) || alias.includes(actual))
      || actual.includes(wanted)
      || wanted.includes(actual);
  }) || null;
}

function columnAliases(columnName: string): string[] {
  const key = normalizeComparable(columnName);
  const map: Record<string, string[]> = {
    "角色": ["角色"],
    "姓名": ["姓名", "名字", "name"],
    "年级": ["年级"],
    "学校": ["学校"],
    "所在院系专业": ["所在院系专业", "所在院系", "院系专业", "院系", "专业"],
    "联系电话": ["联系电话", "手机", "电话", "联系方式"],
    "email": ["email", "e-mail", "电子邮箱", "邮箱"],
    "电子邮箱": ["电子邮箱", "邮箱", "email", "e-mail"],
    "年龄": ["年龄"],
    "研究方向": ["研究方向"],
    "行政职务专业技术职务": ["行政职务专业技术职务", "行政职务", "专业技术职务", "职务"],
    "手机": ["手机", "联系电话", "电话"],
  };
  return map[key] || [columnName];
}

function findByLabelAndPosition(cells: TableCellRef[], fieldPath: string): TableCellRef | undefined {
  const label = findLabelCell(cells, fieldPath);
  if (!label) return undefined;
  const sameTable = cells.filter(cell => cell.tableIndex === label.tableIndex);
  return sameTable
    .filter(cell => cell.row === label.row && cell.col > label.col && normalizeText(cell.text) && !isLikelyLabelCell(cell))
    .sort((a, b) => a.col - b.col)[0];
}

function findSameCellKeyValue(cells: TableCellRef[], fieldPath: string): TableCellRef | undefined {
  const key = normalizeComparable(lastPathPart(fieldPath));
  if (!key) return undefined;
  return cells.find(cell => {
    const text = normalizeComparable(cell.text);
    return text && text.includes(key) && text.length > key.length;
  });
}

function findHorizontalMultiPairRow(cells: TableCellRef[], fieldPath: string): TableCellRef | undefined {
  const label = findLabelCell(cells, fieldPath);
  if (!label) return undefined;
  const rowCells = cells
    .filter(cell => cell.tableIndex === label.tableIndex && cell.row === label.row)
    .sort((a, b) => a.col - b.col);
  const labelIndex = rowCells.findIndex(cell => cell.nodeId === label.nodeId);
  const valueCell = labelIndex >= 0 ? rowCells[labelIndex + 1] : undefined;
  if (!valueCell || !normalizeText(valueCell.text) || isLikelyLabelCell(valueCell)) return undefined;
  return valueCell;
}

function findLabelCell(cells: TableCellRef[], fieldPath: string): TableCellRef | undefined {
  const aliases = fieldAliases(fieldPath).map(normalizeComparable);
  return cells.find(cell => {
    const text = normalizeComparable(cell.text);
    if (!text) return false;
    return aliases.some(alias => text === alias || text.includes(alias) || alias.includes(text));
  });
}

function fieldAliases(fieldPath: string): string[] {
  const key = lastPathPart(fieldPath);
  const canonical = normalizeComparable(key);
  const map: Record<string, string[]> = {
    "项目名称": ["项目名称", "项目名", "课题名称"],
    "项目类型": ["项目类型", "项目类别", "类别"],
    "项目负责人": ["项目负责人", "负责人", "主持人"],
    "申报日期": ["申报日期", "申请日期", "日期"],
  };
  return map[canonical] || [key];
}

function isLikelyLabelCell(cell: TableCellRef): boolean {
  const text = normalizeText(cell.text);
  if (!text) return false;
  const normalized = normalizeComparable(text);
  return [...BASIC_FIELD_NAMES, ...APPLICANT_COLUMNS, ...TEACHER_COLUMNS]
    .some(label => normalized === normalizeComparable(label));
}

function findCellAt(cells: TableCellRef[], tableIndex: number, row: number, col: number): TableCellRef | undefined {
  return cells.find(cell => cell.tableIndex === tableIndex && cell.row === row && cell.col === col);
}

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
    tableIndex: targetTableIndex,
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
  for (const [key, value] of Object.entries(data)) appendValue(fields, key, value);
  return fields.filter(field => field.value.trim());
}

function appendValue(fields: Array<{ path: string; value: string }>, path: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const [childKey, childValue] of Object.entries(item as Record<string, unknown>)) {
          appendValue(fields, `${path}.${index}.${childKey}`, childValue);
        }
      } else if (item !== null && item !== undefined) {
        appendValue(fields, `${path}.${index}`, item);
      }
    });
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

function detectDuplicateTemplates(templates: ReferenceFieldTemplate[]): DuplicateTemplateGroup[] {
  const groups = new Map<string, ReferenceFieldTemplate[]>();
  for (const template of templates) {
    const key = `${template.tableIndex}:${template.row}:${template.col}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(template);
  }

  return [...groups.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([targetKey, values]) => ({
      targetKey,
      tableIndex: values[0].tableIndex,
      row: values[0].row,
      col: values[0].col,
      fieldPaths: values.map(value => value.fieldPath),
    }));
}

function buildRows(cells: TableCellRef[]): Map<number, RowInfo> {
  const rows = new Map<number, RowInfo>();
  for (const cell of cells) {
    if (typeof cell.row !== "number") continue;
    if (!rows.has(cell.row)) rows.set(cell.row, { row: cell.row, cells: [], nonEmptyCells: [], texts: [] });
    const row = rows.get(cell.row)!;
    row.cells.push(cell);
    const text = normalizeText(cell.text);
    if (text) {
      row.nonEmptyCells.push(cell);
      row.texts.push(text);
    }
  }
  return rows;
}

function countHeaderMatches(texts: string[], expectedColumns: string[]): number {
  const normalizedTexts = texts.map(normalizeComparable).filter(Boolean);
  return expectedColumns.filter(expected => {
    const wanted = normalizeComparable(expected);
    return normalizedTexts.some(text => text === wanted || text.includes(wanted) || wanted.includes(text));
  }).length;
}

function averageTextLength(cells: TableCellRef[]): number {
  return cells.reduce((sum, cell) => sum + normalizeText(cell.text).length, 0) / Math.max(cells.length, 1);
}

function lastPathPart(fieldPath: string): string {
  const parts = fieldPath.split(".");
  return parts[parts.length - 1] || fieldPath;
}

function normalizeComparable(value: string): string {
  return normalizeText(value)
    .replace(/[\s:：,，;；。．.、/／\\\-—_()（）[\]【】]/g, "")
    .toLowerCase();
}

export const __testing = {
  extractSectionTemplates,
  findLikelyHeaderRow,
  findLikelyHeaderRowInSection,
  detectDuplicateTemplates,
};
