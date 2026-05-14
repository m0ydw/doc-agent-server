import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { ToolDefinition } from "../toolTypes";

export const InspectDocumentsArgsSchema = z.object({
  docId: z.string().optional(),
  referenceDocId: z.string().optional(),
  targetDocId: z.string().optional(),
  includeRaw: z.boolean().optional().default(false),
});

const DocumentSummarySchema = z.object({
  docId: z.string(),
  originalName: z.string(),
  uploadedAt: z.string(),
  isActive: z.boolean(),
  isReference: z.boolean(),
  isTarget: z.boolean(),
});

const ParsedDocumentSummarySchema = z.object({
  docId: z.string(),
  tableCount: z.number(),
  totalCellCount: z.number(),
  tables: z.array(z.object({
    index: z.number(),
    rows: z.number(),
    cols: z.number(),
    cellCount: z.number(),
    nonEmptyCellCount: z.number(),
  })),
  extractionMethod: z.string(),
  extractionConfidence: z.number(),
  extractionCoverage: z.number(),
});

export const InspectDocumentsResultSchema = z.object({
  documents: z.array(DocumentSummarySchema),
  activeDocId: z.string().optional(),
  referenceDocId: z.string().optional(),
  targetDocId: z.string().optional(),
  parsedDocuments: z.array(ParsedDocumentSummarySchema).optional(),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  raw: z.unknown().optional(),
});

export type InspectDocumentsArgs = z.infer<typeof InspectDocumentsArgsSchema>;
export type InspectDocumentsResult = z.infer<typeof InspectDocumentsResultSchema>;

export function createInspectDocumentsTool(): ToolDefinition<
  typeof InspectDocumentsArgsSchema,
  typeof InspectDocumentsResultSchema
> {
  return {
    name: "inspect_documents",
    description:
      "Read-only tool for inspecting available document ids, active/reference/target document state, and SDK-derived document structure summaries. It never writes to DOCX.",
    permission: "read",
    argsSchema: InspectDocumentsArgsSchema,
    resultSchema: InspectDocumentsResultSchema,
    guard: () => {
      if (fileRegistry.count === 0) {
        return {
          allowed: false,
          reason: "No available documents are registered.",
          warnings: ["Upload or register at least one document before inspecting documents."],
        };
      }

      return { allowed: true };
    },
    execute: async (args, context) => {
      const activeDocId = args.docId || context.docId;
      const referenceDocId = args.referenceDocId || context.referenceDocId;
      const targetDocId = args.targetDocId || context.targetDocId || activeDocId;
      const documents = fileRegistry.getAll();
      const warnings: string[] = [];

      const documentSummaries = documents.map(doc => ({
        docId: doc.docId,
        originalName: doc.originalName,
        uploadedAt: doc.uploadedAt,
        isActive: doc.docId === activeDocId,
        isReference: doc.docId === referenceDocId,
        isTarget: doc.docId === targetDocId,
      }));

      for (const id of [activeDocId, referenceDocId, targetDocId]) {
        if (id && !fileRegistry.get(id)) {
          warnings.push(`Document not found in registry: ${id}`);
        }
      }

      const idsToInspect = uniqueDefined([activeDocId, referenceDocId, targetDocId])
        .filter(id => Boolean(fileRegistry.get(id)));
      const parsedDocuments = [];
      const raw: Record<string, unknown> = {};

      for (const id of idsToInspect) {
        try {
          const payload = await parseDocument(id, false);
          parsedDocuments.push({
            docId: id,
            tableCount: payload.tables.length,
            totalCellCount: payload.tables.reduce((sum, table) => sum + table.cells.length, 0),
            tables: payload.tables.map(table => ({
              index: table.index,
              rows: table.rows,
              cols: table.cols,
              cellCount: table.cells.length,
              nonEmptyCellCount: table.cells.filter(cell => cell.text.trim() !== "").length,
            })),
            extractionMethod: payload.extractionMethod,
            extractionConfidence: payload.extractionConfidence,
            extractionCoverage: payload.extractionCoverage,
          });

          if (args.includeRaw) {
            raw[id] = payload;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown parseDocument error";
          warnings.push(`Failed to inspect document ${id}: ${message}`);
        }
      }

      const result: InspectDocumentsResult = {
        documents: documentSummaries,
        activeDocId,
        referenceDocId,
        targetDocId,
        parsedDocuments,
        summary: buildSummary(documentSummaries.length, parsedDocuments.length, warnings.length),
        warnings,
      };

      if (args.includeRaw) {
        result.raw = raw;
      }

      return result;
    },
  };
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function buildSummary(documentCount: number, inspectedCount: number, warningCount: number): string {
  const warningText = warningCount > 0 ? `, warnings=${warningCount}` : "";
  return `documents=${documentCount}, inspected=${inspectedCount}${warningText}`;
}
