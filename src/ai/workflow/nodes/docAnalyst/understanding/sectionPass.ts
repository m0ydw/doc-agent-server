/**
 * ================================================================
 * Section Pass
 * ================================================================
 *
 * Pass 2: 区域理解（可并发执行）
 */

import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { SectionUnderstanding, Section, ParsedDocumentPayload } from "../types";
import { makeCellNodeId } from "../types";
import type { TokenBudgetManager } from "../complexity/complexityClassifier";
import { SECTION_SYSTEM_PROMPT, buildSectionPrompt } from "./prompts/section";
import { invokeWithStructuredOutput } from "../../../../tools/structuredOutput";

/** Section Understanding Schema */
const SectionUnderstandingSchema = z.object({
  sectionId: z.string(),
  semanticMeaning: z.string(),
  fieldGroups: z.array(z.object({
    name: z.string(),
    nodeIds: z.array(z.string()),
  })),
  rowPatterns: z.array(z.object({
    templateRow: z.number(),
    repeatRows: z.array(z.number()),
    meaning: z.string(),
  })),
  writableAreas: z.array(z.object({
    nodeId: z.string(),
    reason: z.string(),
    confidence: z.number(),
  })),
});

/**
 * 提取区域数据
 */
export function extractSectionData(
  section: Section,
  payload: ParsedDocumentPayload
): string {
  const table = payload.tables.find(t => t.index === section.tableIndex);
  if (!table) {
    return JSON.stringify({ sectionId: section.id, cells: [] });
  }

  const sectionCells = table.cells.filter(
    c => c.row >= section.startRow && c.row <= section.endRow
  );

  return JSON.stringify({
    sectionId: section.id,
    tableIndex: section.tableIndex,
    startRow: section.startRow,
    endRow: section.endRow,
    type: section.type,
    confidence: section.confidence,
    boundaryType: section.boundaryType,
    cells: sectionCells.map(c => ({
      nodeId: makeCellNodeId(section.tableIndex, c.row, c.col),
      row: c.row,
      col: c.col,
      text: c.text,
      rowspan: c.rowspan,
      colspan: c.colspan,
    })),
  }, null, 2);
}

/**
 * 执行 Section Pass
 */
export async function sectionPass(
  llm: ChatOpenAI,
  section: Section,
  payload: ParsedDocumentPayload,
  tokenBudget: TokenBudgetManager
): Promise<SectionUnderstanding> {
  const sectionData = extractSectionData(section, payload);
  const estimatedTokens = tokenBudget.estimateTokens(sectionData);

  // 检查 token 预算
  if (!tokenBudget.canAfford(estimatedTokens + 500)) {
    throw new Error(`Insufficient token budget for section pass: ${section.id}`);
  }

  const prompt = buildSectionPrompt(sectionData);

  const result = await invokeWithStructuredOutput(
    llm,
    SectionUnderstandingSchema,
    SECTION_SYSTEM_PROMPT,
    prompt
  );

  tokenBudget.consume(estimatedTokens + 500);

  return result as SectionUnderstanding;
}
