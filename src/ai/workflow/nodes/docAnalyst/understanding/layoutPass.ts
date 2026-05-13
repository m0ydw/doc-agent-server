/**
 * ================================================================
 * Layout Pass
 * ================================================================
 *
 * Pass 1: 布局理解
 */

import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { LayoutUnderstanding, StructuralSummary } from "../types";
import type { TokenBudgetManager } from "../complexity/complexityClassifier";
import { LAYOUT_SYSTEM_PROMPT, buildLayoutPrompt } from "./prompts/layout";
import { invokeWithStructuredOutput } from "../../../../tools/structuredOutput";

/** Layout Understanding Schema */
const LayoutUnderstandingSchema = z.object({
  tableType: z.string(),
  sectionBoundaries: z.array(
    z.object({
      startRow: z.number(),
      endRow: z.number(),
      purpose: z.string(),
    })
  ),
  repeatedStructures: z.array(
    z.object({
      type: z.string(),
      templateRows: z.array(z.number()),
    })
  ),
  fillableRegions: z.array(
    z.object({
      startRow: z.number(),
      endRow: z.number(),
      startCol: z.number(),
      endCol: z.number(),
      confidence: z.number(),
    })
  ),
});

/**
 * 执行 Layout Pass
 */
export async function layoutPass(
  llm: ChatOpenAI,
  summary: StructuralSummary,
  tokenBudget: TokenBudgetManager
): Promise<LayoutUnderstanding> {
  const summaryText = JSON.stringify(summary, null, 2);
  const estimatedTokens = tokenBudget.estimateTokens(summaryText);

  const prompt = buildLayoutPrompt(summaryText);

  const result = await invokeWithStructuredOutput(
    llm,
    LayoutUnderstandingSchema,
    LAYOUT_SYSTEM_PROMPT,
    prompt
  );

  tokenBudget.consume(estimatedTokens + 500);

  return result as LayoutUnderstanding;
}
