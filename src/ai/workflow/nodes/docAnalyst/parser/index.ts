/**
 * ================================================================
 * Document Parser 入口
 * ================================================================
 *
 * Layer 1: 批量提取所有表格、单元格、ref、文本
 */

import * as sessionManager from "../../../../../services/session";
import type { ParsedDocumentPayload, RawTable } from "../types";
import { CentralizedTextExtractor } from "./textExtractor";
import { extractCellsFromTable } from "./cellExtractor";

/**
 * 解析文档
 *
 * @param docId 文档 ID
 * @param isComplexMode 是否为复杂模式（影响文本提取策略）
 * @returns 解析后的文档负载
 */
export async function parseDocument(
  docId: string,
  isComplexMode: boolean = false
): Promise<ParsedDocumentPayload> {
  const { doc } = await sessionManager.createOrUseSession(docId);

  // 1. 批量获取所有表格块
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

  // 2. 集中提取文本
  const textExtractor = new CentralizedTextExtractor();

  // 对第一个表格提取文本（获取 refTextMap 和 nodeRefMap）
  const textResult = await textExtractor.extract(doc, blocks[0].nodeId, isComplexMode);

  // 3. 提取所有表格数据
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
