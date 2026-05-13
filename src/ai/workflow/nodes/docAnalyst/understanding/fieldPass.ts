import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type {
  FieldUnderstanding,
  LayoutUnderstanding,
  SectionUnderstanding,
  ParsedDocumentPayload,
  LogicalSpatialGraph,
} from "../types";
import { makeCellNodeId } from "../types";
import type { TokenBudgetManager } from "../complexity/complexityClassifier";
import { FIELD_SYSTEM_PROMPT, buildFieldPrompt } from "./prompts/field";
import { invokeWithStructuredOutput } from "../../../../tools/structuredOutput";

const SemanticTypeSchema = z.object({
  generalType: z.string(),
  domainType: z.string().optional(),
});

const FieldUnderstandingSchema = z.object({
  nodeId: z.string(),
  role: z.enum([
    "label", "value", "empty_fillable", "fillable_with_placeholder",
    "section_title", "table_header", "readonly", "computed",
    "decorative", "static_text", "unknown",
  ]),
  semanticType: SemanticTypeSchema,
  confidence: z.number(),
  spatialReason: z.string(),
  semanticReason: z.string(),
  neighboringNodes: z.array(z.string()),
});

const FieldUnderstandingArraySchema = z.array(FieldUnderstandingSchema);

function extractFieldData(
  layoutUnderstanding: LayoutUnderstanding,
  sectionUnderstandings: SectionUnderstanding[],
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph
): string {
  const cellData = payload.tables.flatMap(table => table.cells.map(cell => {
    const nodeId = makeCellNodeId(table.index, cell.row, cell.col);
    const neighborhood = graph.neighborhoods.get(nodeId);

    return {
      nodeId,
      tableIndex: table.index,
      row: cell.row,
      col: cell.col,
      text: cell.text,
      rowspan: cell.rowspan,
      colspan: cell.colspan,
      neighborhood: {
        top: neighborhood?.top,
        bottom: neighborhood?.bottom,
        left: neighborhood?.left,
        right: neighborhood?.right,
        sectionId: neighborhood?.sectionId,
      },
    };
  }));

  return JSON.stringify({
    layoutUnderstanding,
    sectionUnderstandings,
    cells: cellData,
  }, null, 2);
}

export async function fieldPass(
  llm: ChatOpenAI,
  layoutUnderstanding: LayoutUnderstanding,
  sectionUnderstandings: SectionUnderstanding[],
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph,
  tokenBudget: TokenBudgetManager
): Promise<FieldUnderstanding[]> {
  const fieldData = extractFieldData(layoutUnderstanding, sectionUnderstandings, payload, graph);
  const estimatedTokens = tokenBudget.estimateTokens(fieldData);

  if (!tokenBudget.canAfford(estimatedTokens + 1000)) {
    return fieldPassInBatches(llm, layoutUnderstanding, sectionUnderstandings, payload, graph, tokenBudget);
  }

  const prompt = buildFieldPrompt(fieldData);
  const result = await invokeWithStructuredOutput(
    llm,
    FieldUnderstandingArraySchema,
    FIELD_SYSTEM_PROMPT,
    prompt
  );

  tokenBudget.consume(estimatedTokens + 1000);
  return result as FieldUnderstanding[];
}

async function fieldPassInBatches(
  llm: ChatOpenAI,
  layoutUnderstanding: LayoutUnderstanding,
  sectionUnderstandings: SectionUnderstanding[],
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph,
  tokenBudget: TokenBudgetManager
): Promise<FieldUnderstanding[]> {
  const results: FieldUnderstanding[] = [];
  const batchSize = 10;

  for (const table of payload.tables) {
    const rows = [...new Set(table.cells.map(c => c.row))].sort((a, b) => a - b);

    for (let i = 0; i < rows.length; i += batchSize) {
      const batchRows = rows.slice(i, i + batchSize);
      const batchCells = table.cells.filter(c => batchRows.includes(c.row));
      const batchPayload: ParsedDocumentPayload = {
        ...payload,
        tables: [{
          ...table,
          cells: batchCells,
          rows: batchRows.length,
        }],
      };
      const batchData = extractFieldData(layoutUnderstanding, sectionUnderstandings, batchPayload, graph);
      const prompt = buildFieldPrompt(batchData);

      try {
        const result = await invokeWithStructuredOutput(
          llm,
          FieldUnderstandingArraySchema,
          FIELD_SYSTEM_PROMPT,
          prompt
        );
        results.push(...(result as FieldUnderstanding[]));
        tokenBudget.consume(tokenBudget.estimateTokens(batchData) + 1000);
      } catch (err) {
        console.warn(`[FieldPass] Batch ${table.index}:${i} failed:`, err);
      }

      if (!tokenBudget.canAfford(2000)) {
        return results;
      }
    }
  }

  return results;
}
