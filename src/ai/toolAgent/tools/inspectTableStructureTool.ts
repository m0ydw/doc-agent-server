import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { ToolDefinition, ToolExecutionContext } from "../toolTypes";

export const InspectTableStructureArgsSchema = z.object({
  docId: z.string().optional(),
  tableIndex: z.number().int().nonnegative().optional(),
  includeCells: z.boolean().optional().default(false),
  includeRaw: z.boolean().optional().default(false),
  maxCells: z.number().int().positive().optional().default(200),
});

const CellSummarySchema = z.object({
  row: z.number(),
  col: z.number(),
  rowspan: z.number(),
  colspan: z.number(),
  hasText: z.boolean(),
  textPreview: z.string(),
  ref: z.string(),
  nodeId: z.string(),
});

const HeaderCandidateSchema = z.object({
  row: z.number(),
  nonEmptyCellCount: z.number(),
  texts: z.array(z.string()),
});

const TableStructureSummarySchema = z.object({
  index: z.number(),
  rows: z.number(),
  cols: z.number(),
  cellCount: z.number(),
  nonEmptyCellCount: z.number(),
  emptyCellCount: z.number().optional(),
  fillableCellCount: z.number().optional(),
  headerCandidates: z.array(HeaderCandidateSchema).optional(),
  cells: z.array(CellSummarySchema).optional(),
});

export const InspectTableStructureResultSchema = z.object({
  docId: z.string(),
  tableCount: z.number(),
  tables: z.array(TableStructureSummarySchema),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  raw: z.unknown().optional(),
});

export type InspectTableStructureArgs = z.infer<typeof InspectTableStructureArgsSchema>;
export type InspectTableStructureResult = z.infer<typeof InspectTableStructureResultSchema>;

export function createInspectTableStructureTool(): ToolDefinition<
  typeof InspectTableStructureArgsSchema,
  typeof InspectTableStructureResultSchema
> {
  return {
    name: "inspect_table_structure",
    description:
      "Read-only tool for inspecting one document's table structure, including row/column counts, cell counts, non-empty counts, header candidates, and optional bounded cell summaries. It never writes to DOCX.",
    permission: "read",
    argsSchema: InspectTableStructureArgsSchema,
    resultSchema: InspectTableStructureResultSchema,
    guard: (args, context) => {
      if (fileRegistry.count === 0) {
        return {
          allowed: false,
          reason: "No available documents are registered.",
          warnings: ["Upload or register at least one document before inspecting table structure."],
        };
      }

      const docId = resolveDocId(args, context);
      if (docId && !fileRegistry.get(docId)) {
        return {
          allowed: false,
          reason: `Document not found in registry: ${docId}`,
        };
      }

      if (!docId && fileRegistry.count > 1) {
        return {
          allowed: false,
          reason: "Multiple documents are available; provide docId, targetDocId, or referenceDocId.",
        };
      }

      return { allowed: true };
    },
    execute: async (args, context) => {
      const docId = resolveDocId(args, context);
      const warnings: string[] = [];

      if (!docId) {
        return {
          docId: "",
          tableCount: 0,
          tables: [],
          summary: "No document id could be resolved.",
          warnings: ["No docId, targetDocId, referenceDocId, or single registered document was available."],
        };
      }

      const doc = fileRegistry.get(docId);
      if (!doc) {
        return {
          docId,
          tableCount: 0,
          tables: [],
          summary: `Document not found: ${docId}`,
          warnings: [`Document not found in registry: ${docId}`],
        };
      }

      const payload = await parseDocument(docId, false);
      const selectedTables = args.tableIndex === undefined
        ? payload.tables
        : payload.tables.filter(table => table.index === args.tableIndex);

      if (args.tableIndex !== undefined && selectedTables.length === 0) {
        warnings.push(`Table not found: ${args.tableIndex}`);
      }

      let remainingCells = args.maxCells;
      const tables = selectedTables.map(table => {
        const nonEmptyCellCount = table.cells.filter(cell => cell.text.trim() !== "").length;
        const emptyCellCount = table.cells.length - nonEmptyCellCount;
        const summary = {
          index: table.index,
          rows: table.rows,
          cols: table.cols,
          cellCount: table.cells.length,
          nonEmptyCellCount,
          emptyCellCount,
          fillableCellCount: emptyCellCount,
          headerCandidates: buildHeaderCandidates(table.cells),
        };

        if (!args.includeCells) {
          return summary;
        }

        const cellsToReturn = table.cells.slice(0, Math.max(0, remainingCells));
        remainingCells -= cellsToReturn.length;

        if (cellsToReturn.length < table.cells.length) {
          warnings.push(`Cells truncated for table ${table.index}: returned ${cellsToReturn.length}/${table.cells.length}`);
        }

        return {
          ...summary,
          cells: cellsToReturn.map(cell => ({
            row: cell.row,
            col: cell.col,
            rowspan: cell.rowspan,
            colspan: cell.colspan,
            hasText: cell.text.trim() !== "",
            textPreview: cell.text.replace(/\s+/g, " ").slice(0, 80),
            ref: cell.ref,
            nodeId: cell.nodeId,
          })),
        };
      });

      const result: InspectTableStructureResult = {
        docId,
        tableCount: payload.tables.length,
        tables,
        summary: buildSummary(doc.originalName, payload.tables.length, tables.length),
        warnings,
      };

      if (args.includeRaw) {
        result.raw = payload;
      }

      return result;
    },
  };
}

function resolveDocId(args: InspectTableStructureArgs, context: ToolExecutionContext): string | undefined {
  if (args.docId) return args.docId;
  if (context.docId) return context.docId;
  if (context.targetDocId) return context.targetDocId;
  if (context.referenceDocId) return context.referenceDocId;

  const docs = fileRegistry.getAll();
  return docs.length === 1 ? docs[0].docId : undefined;
}

function buildHeaderCandidates(cells: Array<{ row: number; text: string }>): Array<{ row: number; nonEmptyCellCount: number; texts: string[] }> {
  const rows = new Map<number, string[]>();

  for (const cell of cells) {
    const text = cell.text.trim();
    if (!text) continue;
    const rowTexts = rows.get(cell.row) || [];
    rowTexts.push(text);
    rows.set(cell.row, rowTexts);
  }

  return Array.from(rows.entries())
    .map(([row, texts]) => ({
      row,
      nonEmptyCellCount: texts.length,
      texts: texts.slice(0, 12),
    }))
    .sort((a, b) => {
      if (b.nonEmptyCellCount !== a.nonEmptyCellCount) {
        return b.nonEmptyCellCount - a.nonEmptyCellCount;
      }
      return a.row - b.row;
    })
    .slice(0, 5);
}

function buildSummary(originalName: string, totalTables: number, returnedTables: number): string {
  return `${originalName}: tables=${totalTables}, returned=${returnedTables}`;
}
