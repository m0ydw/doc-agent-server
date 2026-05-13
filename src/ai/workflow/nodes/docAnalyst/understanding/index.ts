/**
 * ================================================================
 * Multi-pass LLM Understanding 入口
 * ================================================================
 *
 * Layer 5: 分层分析（含 fallback 和并发控制）
 */

import { ChatOpenAI } from "@langchain/openai";
import PromisePool from "@supercharge/promise-pool";
import type {
  ParsedDocumentPayload,
  LogicalSpatialGraph,
  StructuralSummary,
  LayoutUnderstanding,
  SectionUnderstanding,
  FieldUnderstanding,
  AnalysisMode,
} from "../types";
import type { TokenBudgetManager } from "../complexity/complexityClassifier";
import { layoutPass } from "./layoutPass";
import { sectionPass } from "./sectionPass";
import { fieldPass } from "./fieldPass";
import {
  heuristicLayoutAnalysis,
  heuristicFieldAnalysis,
  calculateSpatialConfidence,
  calculatePatternConfidence,
  calculateStructureConfidence,
  weightedAverage,
} from "./heuristicFallback";

/** 分析结果 */
export interface AnalysisResult {
  success: boolean;
  mode: AnalysisMode;
  layoutUnderstanding: LayoutUnderstanding;
  sectionUnderstandings: SectionUnderstanding[];
  fieldUnderstandings: FieldUnderstanding[];
  fallbackUsed: boolean;
  fallbackReason?: string;
  overallConfidence: number;
}

/**
 * 执行文档理解
 */
export async function understandDocument(
  llm: ChatOpenAI,
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph,
  summary: StructuralSummary,
  mode: AnalysisMode,
  tokenBudget: TokenBudgetManager
): Promise<AnalysisResult> {
  try {
    // 尝试 LLM 分析
    const result = await performLLMAnalysis(llm, payload, graph, summary, mode, tokenBudget);

    // 检查置信度
    if (result.overallConfidence >= 0.6) {
      return {
        ...result,
        success: true,
        fallbackUsed: false,
      };
    }

    // 置信度过低，降级到 simpler mode
    console.warn("[DocAnalyst] LLM analysis confidence too low, falling back");
    return fallbackAnalysis(payload, graph, mode, "Low confidence");

  } catch (err) {
    // LLM 分析失败，降级到 heuristic-only mode
    console.error("[DocAnalyst] LLM analysis failed:", err);
    return fallbackAnalysis(payload, graph, mode, (err as Error).message);
  }
}

/**
 * 执行 LLM 分析
 */
async function performLLMAnalysis(
  llm: ChatOpenAI,
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph,
  summary: StructuralSummary,
  mode: AnalysisMode,
  tokenBudget: TokenBudgetManager
): Promise<AnalysisResult> {
  // Pass 1: Layout Understanding (always)
  const layoutUnderstanding = await layoutPass(llm, summary, tokenBudget);

  // Pass 2: Section Understanding (并发执行，仅 standard/complex)
  let sectionUnderstandings: SectionUnderstanding[] = [];
  if (mode !== "simple" && graph.sections.length > 0) {
    const { results } = await PromisePool
      .withConcurrency(3)
      .for(graph.sections)
      .process(async (section) => {
        return sectionPass(llm, section, payload, tokenBudget);
      });
    sectionUnderstandings = results;
  }

  // Pass 3: Field Understanding (always)
  const fieldUnderstandings = await fieldPass(
    llm, layoutUnderstanding, sectionUnderstandings, payload, graph, tokenBudget
  );

  // 计算整体置信度
  const overallConfidence = calculateOverallConfidence(
    fieldUnderstandings,
    graph,
    payload
  );

  return {
    success: true,
    mode,
    layoutUnderstanding,
    sectionUnderstandings,
    fieldUnderstandings,
    fallbackUsed: false,
    overallConfidence,
  };
}

/**
 * Fallback 分析（heuristic-only）
 */
function fallbackAnalysis(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph,
  originalMode: AnalysisMode,
  reason?: string
): AnalysisResult {
  // 使用启发式方法分析
  const fieldUnderstandings = heuristicFieldAnalysis(payload, graph);
  const layoutUnderstanding = heuristicLayoutAnalysis(payload, graph);

  // 动态计算 confidence
  const spatialConfidence = calculateSpatialConfidence(graph);
  const patternConfidence = calculatePatternConfidence(graph);
  const structureConfidence = calculateStructureConfidence(payload, graph);

  const overallConfidence = weightedAverage([
    { value: spatialConfidence, weight: 0.4 },
    { value: patternConfidence, weight: 0.3 },
    { value: structureConfidence, weight: 0.3 },
  ]);

  return {
    success: true,
    mode: "simple", // 降级到简单模式
    layoutUnderstanding,
    sectionUnderstandings: [],
    fieldUnderstandings,
    fallbackUsed: true,
    fallbackReason: reason || "Low confidence",
    overallConfidence, // 动态计算，而不是固定 0.3
  };
}

/**
 * 计算整体置信度
 */
function calculateOverallConfidence(
  fieldUnderstandings: FieldUnderstanding[],
  graph: LogicalSpatialGraph,
  payload: ParsedDocumentPayload
): number {
  if (fieldUnderstandings.length === 0) return 0;

  // 字段分析的平均置信度
  const avgFieldConfidence = fieldUnderstandings.reduce(
    (sum, f) => sum + f.confidence, 0
  ) / fieldUnderstandings.length;

  // 空间置信度
  const spatialConfidence = calculateSpatialConfidence(graph);

  // 结构置信度
  const structureConfidence = calculateStructureConfidence(payload, graph);

  return weightedAverage([
    { value: avgFieldConfidence, weight: 0.5 },
    { value: spatialConfidence, weight: 0.25 },
    { value: structureConfidence, weight: 0.25 },
  ]);
}

export { layoutPass } from "./layoutPass";
export { sectionPass, extractSectionData } from "./sectionPass";
export { fieldPass } from "./fieldPass";
export {
  heuristicLayoutAnalysis,
  heuristicFieldAnalysis,
  calculateSpatialConfidence,
  calculatePatternConfidence,
  calculateStructureConfidence,
  weightedAverage,
} from "./heuristicFallback";
