import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { ToolDefinition, ToolExecutionContext } from "../toolTypes";

export const InspectSdkCellTextArgsSchema = z.object({
  docId: z.string().optional(),
  tableIndex: z.number().int().nonnegative().optional(),
  row: z.number().int().nonnegative().optional(),
  col: z.number().int().nonnegative().optional(),
  searchTerms: z.array(z.string()).optional(),
  includeEmptyCells: z.boolean().optional().default(true),
  includeCells: z.boolean().optional().default(true),
  includeRaw: z.boolean().optional().default(false),
  maxCells: z.number().int().positive().optional().default(200),
  maxTextLength: z.number().int().positive().optional().default(200),
});

const SearchMatchSchema = z.object({
  term: z.string(),
  count: z.number(),
});

const CellTextDiagnosticSchema = z.object({
  tableIndex: z.number(),
  row: z.number().optional(),
  col: z.number().optional(),
  hasText: z.boolean(),
  textPreview: z.string(),
  textLength: z.number(),
  matchedTerms: z.array(z.string()).optional(),
  ref: z.string().optional(),
  nodeId: z.string().optional(),
});

const TableTextDiagnosticSchema = z.object({
  index: z.number(),
  rows: z.number().optional(),
  cols: z.number().optional(),
  inspectedCellCount: z.number(),
  cellsWithTextCount: z.number(),
  emptyTextCellCount: z.number(),
  textCoverage: z.number(),
  searchMatches: z.array(SearchMatchSchema).optional(),
  cells: z.array(CellTextDiagnosticSchema).optional(),
});

export const InspectSdkCellTextResultSchema = z.object({
  docId: z.string(),
  tableCount: z.number(),
  inspectedCellCount: z.number(),
  cellsWithTextCount: z.number(),
  emptyTextCellCount: z.number(),
  textCoverage: z.number(),
  tables: z.array(TableTextDiagnosticSchema),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  raw: z.unknown().optional(),
});

export type InspectSdkCellTextArgs = z.infer<typeof InspectSdkCellTextArgsSchema>;
export type InspectSdkCellTextResult = z.infer<typeof InspectSdkCellTextResultSchema>;

export function createInspectSdkCellTextTool(): ToolDefinition<
  typeof InspectSdkCellTextArgsSchema,
  typeof InspectSdkCellTextResultSchema
> {
  return {
    name: "inspect_sdk_cell_text",
    description:
      "Read-only diagnostic tool for checking cell text extraction through the existing SuperDoc SDK and parseDocument path. It reports text coverage, empty cells, and search term matches without writing to DOCX.",
    permission: "diagnostic",
    argsSchema: InspectSdkCellTextArgsSchema,
    resultSchema: InspectSdkCellTextResultSchema,
    guard: (args, context) => {
      if (fileRegistry.count === 0) {
        return {
          allowed: false,
          reason: "No available documents are registered.",
          warnings: ["Upload or register at least one document before inspecting SDK cell text."],
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
        return emptyResult("", "No document id could be resolved.", [
          "No docId, targetDocId, referenceDocId, or single registered document was available.",
        ]);
      }

      if (!fileRegistry.get(docId)) {
        return emptyResult(docId, `Document not found: ${docId}`, [
          `Document not found in registry: ${docId}`,
        ]);
      }

      const payload = await parseDocument(docId, true);
      const selectedTables = payload.tables
        .filter(table => args.tableIndex === undefined || table.index === args.tableIndex);

      if (args.tableIndex !== undefined && selectedTables.length === 0) {
        warnings.push(`Table not found: ${args.tableIndex}`);
      }

      let remainingCells = args.maxCells;
      let inspectedCellCount = 0;
      let cellsWithTextCount = 0;
      let emptyTextCellCount = 0;
      const normalizedSearchTerms = (args.searchTerms || []).filter(term => term.trim() !== "");

      const tables = selectedTables.map(table => {
        const scopedCells = table.cells.filter(cell => {
          if (args.row !== undefined && cell.row !== args.row) return false;
          if (args.col !== undefined && cell.col !== args.col) return false;
          if (!args.includeEmptyCells && cell.text.trim() === "") return false;
          return true;
        });

        const tableCellsWithText = scopedCells.filter(cell => cell.text.trim() !== "").length;
        const tableEmptyTextCells = scopedCells.length - tableCellsWithText;
        inspectedCellCount += scopedCells.length;
        cellsWithTextCount += tableCellsWithText;
        emptyTextCellCount += tableEmptyTextCells;

        const searchMatches = buildSearchMatches(scopedCells.map(cell => cell.text), normalizedSearchTerms);
        const tableResult = {
          index: table.index,
          rows: table.rows,
          cols: table.cols,
          inspectedCellCount: scopedCells.length,
          cellsWithTextCount: tableCellsWithText,
          emptyTextCellCount: tableEmptyTextCells,
          textCoverage: ratio(tableCellsWithText, scopedCells.length),
          searchMatches,
        };

        if (!args.includeCells) {
          return tableResult;
        }

        const cellsToReturn = scopedCells.slice(0, Math.max(0, remainingCells));
        remainingCells -= cellsToReturn.length;

        if (cellsToReturn.length < scopedCells.length) {
          warnings.push(`Cells truncated for table ${table.index}: returned ${cellsToReturn.length}/${scopedCells.length}`);
        }

        return {
          ...tableResult,
          cells: cellsToReturn.map(cell => {
            const matchedTerms = findMatchedTerms(cell.text, normalizedSearchTerms);
            return {
              tableIndex: cell.tableIndex,
              row: cell.row,
              col: cell.col,
              hasText: cell.text.trim() !== "",
              textPreview: truncateText(cell.text, args.maxTextLength),
              textLength: cell.text.length,
              matchedTerms,
              ref: cell.ref,
              nodeId: cell.nodeId,
            };
          }),
        };
      });

      const result: InspectSdkCellTextResult = {
        docId,
        tableCount: payload.tables.length,
        inspectedCellCount,
        cellsWithTextCount,
        emptyTextCellCount,
        textCoverage: ratio(cellsWithTextCount, inspectedCellCount),
        tables,
        summary: buildSummary(payload.extractionMethod, payload.extractionCoverage, inspectedCellCount, cellsWithTextCount),
        warnings,
      };

      if (args.includeRaw) {
        result.raw = payload;
      }

      return result;
    },
  };
}

function resolveDocId(args: InspectSdkCellTextArgs, context: ToolExecutionContext): string | undefined {
  if (args.docId) return args.docId;
  if (context.docId) return context.docId;
  if (context.targetDocId) return context.targetDocId;
  if (context.referenceDocId) return context.referenceDocId;

  const docs = fileRegistry.getAll();
  return docs.length === 1 ? docs[0].docId : undefined;
}

function emptyResult(docId: string, summary: string, warnings: string[]): InspectSdkCellTextResult {
  return {
    docId,
    tableCount: 0,
    inspectedCellCount: 0,
    cellsWithTextCount: 0,
    emptyTextCellCount: 0,
    textCoverage: 0,
    tables: [],
    summary,
    warnings,
  };
}

function buildSearchMatches(texts: string[], terms: string[]): Array<{ term: string; count: number }> {
  return terms.map(term => ({
    term,
    count: texts.filter(text => includesTerm(text, term)).length,
  }));
}

function findMatchedTerms(text: string, terms: string[]): string[] {
  return terms.filter(term => includesTerm(text, term));
}

function includesTerm(text: string, term: string): boolean {
  return text.toLowerCase().includes(term.toLowerCase());
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength);
}

function ratio(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function buildSummary(
  extractionMethod: string,
  extractionCoverage: number,
  inspectedCellCount: number,
  cellsWithTextCount: number
): string {
  return `method=${extractionMethod}, sdkCoverage=${extractionCoverage.toFixed(3)}, inspected=${inspectedCellCount}, withText=${cellsWithTextCount}`;
}
