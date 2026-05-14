import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { RawCell } from "../../workflow/nodes/docAnalyst/types";
import type { ToolDefinition, ToolExecutionContext } from "../toolTypes";

export const ExtractReferenceTemplatesArgsSchema = z.object({
  referenceDocId: z.string().optional(),
  targetDocId: z.string().optional(),
  docId: z.string().optional(),
  includeCells: z.boolean().optional().default(true),
  includeRaw: z.boolean().optional().default(false),
  maxTables: z.number().int().positive().optional().default(20),
  maxCellsPerTable: z.number().int().positive().optional().default(200),
  maxTextLength: z.number().int().positive().optional().default(200),
  detectFieldPatterns: z.boolean().optional().default(true),
});

const HeaderCandidateSchema = z.object({
  row: z.number(),
  texts: z.array(z.string()),
});

const FieldCandidateSchema = z.object({
  label: z.string(),
  valuePreview: z.string().optional(),
  tableIndex: z.number(),
  row: z.number().optional(),
  col: z.number().optional(),
  confidence: z.number().optional(),
  reason: z.string().optional(),
  ref: z.string().optional(),
  nodeId: z.string().optional(),
});

const TemplateCellSchema = z.object({
  tableIndex: z.number(),
  row: z.number().optional(),
  col: z.number().optional(),
  textPreview: z.string(),
  hasText: z.boolean(),
  ref: z.string().optional(),
  nodeId: z.string().optional(),
});

const ReferenceTableTemplateSchema = z.object({
  tableIndex: z.number(),
  rows: z.number().optional(),
  cols: z.number().optional(),
  cellCount: z.number(),
  nonEmptyCellCount: z.number(),
  textCoverage: z.number().optional(),
  headerCandidates: z.array(HeaderCandidateSchema).optional(),
  fieldCandidates: z.array(FieldCandidateSchema).optional(),
  anchorTexts: z.array(z.string()).optional(),
  cells: z.array(TemplateCellSchema).optional(),
});

export const ExtractReferenceTemplatesResultSchema = z.object({
  referenceDocId: z.string(),
  targetDocId: z.string().optional(),
  tableCount: z.number(),
  templates: z.array(ReferenceTableTemplateSchema),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  raw: z.unknown().optional(),
});

export type ExtractReferenceTemplatesArgs = z.infer<typeof ExtractReferenceTemplatesArgsSchema>;
export type ExtractReferenceTemplatesResult = z.infer<typeof ExtractReferenceTemplatesResultSchema>;

export function createExtractReferenceTemplatesTool(): ToolDefinition<
  typeof ExtractReferenceTemplatesArgsSchema,
  typeof ExtractReferenceTemplatesResultSchema
> {
  return {
    name: "extract_reference_templates",
    description:
      "Read-only diagnostic tool that extracts reusable reference templates, field candidates, table patterns, and text anchors from a reference document. It does not generate fill plans or write to DOCX.",
    permission: "diagnostic",
    argsSchema: ExtractReferenceTemplatesArgsSchema,
    resultSchema: ExtractReferenceTemplatesResultSchema,
    guard: (args, context) => {
      if (fileRegistry.count === 0) {
        return {
          allowed: false,
          reason: "No available documents are registered.",
          warnings: ["Upload or register a reference document before extracting templates."],
        };
      }

      const referenceDocId = resolveReferenceDocId(args, context);
      if (referenceDocId && !fileRegistry.get(referenceDocId)) {
        return {
          allowed: false,
          reason: `Reference document not found in registry: ${referenceDocId}`,
        };
      }

      if (!referenceDocId && fileRegistry.count > 1) {
        return {
          allowed: false,
          reason: "Multiple documents are available; provide referenceDocId or docId.",
        };
      }

      return {
        allowed: true,
        warnings: !referenceDocId ? ["No referenceDocId provided; the only registered document will be used."] : undefined,
      };
    },
    execute: async (args, context) => {
      const referenceDocId = resolveReferenceDocId(args, context);
      const targetDocId = args.targetDocId || context.targetDocId;
      const warnings: string[] = [];

      if (!referenceDocId) {
        return {
          referenceDocId: "",
          targetDocId,
          tableCount: 0,
          templates: [],
          summary: "No reference document id could be resolved.",
          warnings: ["No referenceDocId, docId, context referenceDocId, context docId, or single registered document was available."],
        };
      }

      if (!fileRegistry.get(referenceDocId)) {
        return {
          referenceDocId,
          targetDocId,
          tableCount: 0,
          templates: [],
          summary: `Reference document not found: ${referenceDocId}`,
          warnings: [`Reference document not found in registry: ${referenceDocId}`],
        };
      }

      if (targetDocId && !fileRegistry.get(targetDocId)) {
        warnings.push(`Target document not found in registry: ${targetDocId}`);
      }

      const payload = await parseDocument(referenceDocId, true);
      const selectedTables = payload.tables.slice(0, args.maxTables);
      if (selectedTables.length < payload.tables.length) {
        warnings.push(`Tables truncated: returned ${selectedTables.length}/${payload.tables.length}`);
      }

      const templates = selectedTables.map(table => {
        const nonEmptyCells = table.cells.filter(cell => cell.text.trim() !== "");
        const tableTemplate = {
          tableIndex: table.index,
          rows: table.rows,
          cols: table.cols,
          cellCount: table.cells.length,
          nonEmptyCellCount: nonEmptyCells.length,
          textCoverage: ratio(nonEmptyCells.length, table.cells.length),
          headerCandidates: buildHeaderCandidates(table.cells, args.maxTextLength),
          fieldCandidates: args.detectFieldPatterns
            ? buildFieldCandidates(table.cells, args.maxTextLength)
            : [],
          anchorTexts: buildAnchorTexts(table.cells, args.maxTextLength),
        };

        if (!args.includeCells) {
          return tableTemplate;
        }

        const cells = table.cells.slice(0, args.maxCellsPerTable);
        if (cells.length < table.cells.length) {
          warnings.push(`Cells truncated for table ${table.index}: returned ${cells.length}/${table.cells.length}`);
        }

        return {
          ...tableTemplate,
          cells: cells.map(cell => ({
            tableIndex: cell.tableIndex,
            row: cell.row,
            col: cell.col,
            textPreview: truncateText(cell.text, args.maxTextLength),
            hasText: cell.text.trim() !== "",
            ref: cell.ref,
            nodeId: cell.nodeId,
          })),
        };
      });

      const result: ExtractReferenceTemplatesResult = {
        referenceDocId,
        targetDocId,
        tableCount: payload.tables.length,
        templates,
        summary: buildSummary(referenceDocId, templates.length),
        warnings,
      };

      if (args.includeRaw) {
        result.raw = payload;
      }

      return result;
    },
  };
}

function resolveReferenceDocId(
  args: ExtractReferenceTemplatesArgs,
  context: ToolExecutionContext
): string | undefined {
  if (args.referenceDocId) return args.referenceDocId;
  if (args.docId) return args.docId;
  if (context.referenceDocId) return context.referenceDocId;
  if (context.docId) return context.docId;

  const docs = fileRegistry.getAll();
  return docs.length === 1 ? docs[0].docId : undefined;
}

function buildHeaderCandidates(cells: RawCell[], maxTextLength: number): Array<{ row: number; texts: string[] }> {
  const rows = new Map<number, string[]>();

  for (const cell of cells) {
    const text = normalizeCellText(cell.text);
    if (!text) continue;
    const rowTexts = rows.get(cell.row) || [];
    rowTexts.push(truncateText(text, maxTextLength));
    rows.set(cell.row, rowTexts);
  }

  return Array.from(rows.entries())
    .map(([row, texts]) => ({ row, texts: texts.slice(0, 12) }))
    .sort((a, b) => {
      if (b.texts.length !== a.texts.length) return b.texts.length - a.texts.length;
      return a.row - b.row;
    })
    .slice(0, 5);
}

function buildFieldCandidates(cells: RawCell[], maxTextLength: number): Array<{
  label: string;
  valuePreview?: string;
  tableIndex: number;
  row?: number;
  col?: number;
  confidence?: number;
  reason?: string;
  ref?: string;
  nodeId?: string;
}> {
  const candidates: Array<{
    label: string;
    valuePreview?: string;
    tableIndex: number;
    row?: number;
    col?: number;
    confidence?: number;
    reason?: string;
    ref?: string;
    nodeId?: string;
  }> = [];

  for (const cell of cells) {
    const text = normalizeCellText(cell.text);
    if (!text) continue;

    const colonField = splitColonField(text);
    if (colonField) {
      candidates.push({
        label: truncateText(colonField.label, maxTextLength),
        valuePreview: truncateText(colonField.value, maxTextLength) || undefined,
        tableIndex: cell.tableIndex,
        row: cell.row,
        col: cell.col,
        confidence: colonField.value ? 0.85 : 0.75,
        reason: "label detected from colon-delimited cell text",
        ref: cell.ref,
        nodeId: cell.nodeId,
      });
      continue;
    }

    if (!isLikelyLabel(text)) continue;

    const valueCell = findAdjacentValueCell(cells, cell);
    candidates.push({
      label: truncateText(text, maxTextLength),
      valuePreview: valueCell ? truncateText(valueCell.text, maxTextLength) : undefined,
      tableIndex: cell.tableIndex,
      row: cell.row,
      col: cell.col,
      confidence: valueCell ? 0.7 : 0.55,
      reason: valueCell
        ? "label-like cell with right/bottom adjacent value candidate"
        : "label-like cell without adjacent value candidate",
      ref: cell.ref,
      nodeId: cell.nodeId,
    });
  }

  return candidates.slice(0, 100);
}

function buildAnchorTexts(cells: RawCell[], maxTextLength: number): string[] {
  const seen = new Set<string>();
  const anchors: string[] = [];

  for (const cell of cells) {
    const text = normalizeCellText(cell.text);
    if (text.length < 2 || text.length > 80 || seen.has(text)) continue;
    seen.add(text);
    anchors.push(truncateText(text, maxTextLength));
    if (anchors.length >= 30) break;
  }

  return anchors;
}

function splitColonField(text: string): { label: string; value: string } | null {
  const match = text.match(/^(.{1,40}?)[：:]\s*(.*)$/);
  if (!match) return null;
  return {
    label: match[1].trim(),
    value: match[2].trim(),
  };
}

function isLikelyLabel(text: string): boolean {
  if (text.length > 30) return false;
  return /姓名|名称|电话|手机|邮箱|日期|编号|地址|学校|年级|专业|职务|方向|Name|Date|Address|Phone|Email|ID/i.test(text);
}

function findAdjacentValueCell(cells: RawCell[], labelCell: RawCell): RawCell | undefined {
  const right = cells.find(cell =>
    cell.tableIndex === labelCell.tableIndex &&
    cell.row === labelCell.row &&
    cell.col === labelCell.col + labelCell.colspan
  );
  if (right) return right;

  return cells.find(cell =>
    cell.tableIndex === labelCell.tableIndex &&
    cell.row === labelCell.row + labelCell.rowspan &&
    cell.col === labelCell.col
  );
}

function normalizeCellText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number): string {
  const normalized = normalizeCellText(text);
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength);
}

function ratio(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function buildSummary(referenceDocId: string, templateCount: number): string {
  return `referenceDocId=${referenceDocId}, tableTemplates=${templateCount}`;
}
