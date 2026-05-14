import * as sessionManager from "../../../../../services/session";
import type { ParsedDocumentPayload, RawTable } from "../types";
import { CentralizedTextExtractor } from "./textExtractor";
import { extractCellsFromTable } from "./cellExtractor";

export async function parseDocument(
  docId: string,
  isComplexMode: boolean = false
): Promise<ParsedDocumentPayload> {
  const { doc } = await sessionManager.createOrUseSession(docId);

  const tableBlocks = await doc.blocks.list({
    nodeTypes: ["table"],
    limit: 100,
  } as Record<string, unknown>);

  const blocks = ((tableBlocks as Record<string, unknown>).blocks || []) as Array<{
    nodeId: string;
  }>;

  if (!blocks.length) {
    return {
      docId,
      tables: [],
      refTextMap: new Map(),
      nodeRefMap: new Map(),
      extractionMethod: "none",
      extractionConfidence: 0,
      extractionCoverage: 0,
    };
  }

  const textExtractor = new CentralizedTextExtractor();
  const textResult = await textExtractor.extract(doc, blocks[0].nodeId, isComplexMode);

  const tables: RawTable[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const table = await extractCellsFromTable(
      doc,
      blocks[i].nodeId,
      i,
      textResult.nodeRefMap,
      textResult.refTextMap
    );
    tables.push(table);
  }

  return {
    docId,
    tables,
    refTextMap: textResult.refTextMap,
    nodeRefMap: textResult.nodeRefMap,
    extractionMethod: textResult.extractionMethod,
    extractionConfidence: textResult.confidence,
    extractionCoverage: textResult.coverage,
  };
}

export { CentralizedTextExtractor } from "./textExtractor";
export { extractCellsFromTable, detectMergedCells, buildGrid } from "./cellExtractor";
