/**
 * ================================================================
 * DocAnalyst 节点入口
 * ================================================================
 *
 * Layer 1-8: 文档理解（不负责执行）
 *
 * 职责：
 * - Parser → Spatial Graph → Summarization → Multi-pass Understanding → Semantic Schema
 *
 * 不负责：
 * - Execution Planning
 * - Document Filling
 */

import { ChatOpenAI } from "@langchain/openai";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../../state";
import type { AnalysisArtifacts, SemanticDocumentSchema, AnalysisMode } from "./types";
import { parseDocument } from "./parser";
import { buildSpatialGraph } from "./spatial";
import { classifyComplexity, TokenBudgetManager } from "./complexity";
import { generateStructuralSummary } from "./summarizer";
import { understandDocument } from "./understanding";
import { saveArtifacts, buildArtifacts } from "./artifacts";
import { buildSemanticSchema, saveSchema } from "./schema";
import { analyzeReferenceAndTargetTables } from "../tableFill/analyzer";

/**
 * 创建 DocAnalyst 节点函数
 */
export function createDocAnalystNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
    const docId = state.docId;
    const logs: string[] = [];

    try {
      logs.push("[DocAnalyst] Starting document analysis...");

      if (state.referenceDocId && state.targetDocId) {
        logs.push(`[DocAnalyst] Reference/target mode: reference=${state.referenceDocId}, target=${state.targetDocId}`);
        const userData = JSON.parse(state.extractedData || "{}") as Record<string, unknown>;
        const tableAnalysis = await analyzeReferenceAndTargetTables(
          state.referenceDocId,
          state.targetDocId,
          userData,
        );
        logs.push(`[DocAnalyst] Reference tables=${tableAnalysis.reference.tables.length}, target tables=${tableAnalysis.target.tables.length}`);
        logs.push(`[DocAnalyst] Field templates=${tableAnalysis.templates.length}, failed=${tableAnalysis.failedReasons.length}`);

        if (tableAnalysis.templates.length === 0) {
          logs.push("[DocAnalyst] Failed: no field position templates were extracted from reference document");
          return {
            tableAnalysisId: tableAnalysis.analysisId,
            executionLog: logs.join("\n"),
            delegationStep: (state.delegationStep ?? 0) + 1,
            lastAgent: "DocAnalyst",
            success: false,
            workflowError: "参考文档未能建立任何字段位置模板，无法生成目标文档写入计划。",
          };
        }

        return {
          tableAnalysisId: tableAnalysis.analysisId,
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocAnalyst",
          success: true,
        };
      }

      // ================================================================
      // Layer 1: Document Parser
      // ================================================================
      logs.push("[DocAnalyst] Layer 1: Parsing document...");
      const payload = await parseDocument(docId, false);

      if (payload.tables.length === 0) {
        logs.push("[DocAnalyst] No tables found in document");
        return {
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocAnalyst",
          success: false,
        };
      }

      logs.push(`[DocAnalyst] Found ${payload.tables.length} tables, extraction method: ${payload.extractionMethod}, coverage: ${(payload.extractionCoverage * 100).toFixed(1)}%`);

      // ================================================================
      // Layer 2: Logical Spatial Graph
      // ================================================================
      logs.push("[DocAnalyst] Layer 2: Building spatial graph...");
      const graph = buildSpatialGraph(payload);
      logs.push(`[DocAnalyst] Built graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.sections.length} sections, ${graph.repeatedPatterns.length} patterns`);

      // ================================================================
      // Layer 3: Complexity Classifier
      // ================================================================
      logs.push("[DocAnalyst] Layer 3: Classifying complexity...");
      const complexity = classifyComplexity(payload, graph);
      logs.push(`[DocAnalyst] Complexity: score=${complexity.score.toFixed(2)}, mode=${complexity.mode}, estimatedTokens=${complexity.factors.estimatedTokens}`);

      // 重新解析文档（如果需要 complex mode）
      if (complexity.mode === "complex" && payload.extractionCoverage < 0.7) {
        logs.push("[DocAnalyst] Re-parsing with complex mode...");
        const complexPayload = await parseDocument(docId, true);
        if (complexPayload.extractionCoverage > payload.extractionCoverage) {
          Object.assign(payload, complexPayload);
        }
      }

      // ================================================================
      // Layer 4: Structural Summarization
      // ================================================================
      logs.push("[DocAnalyst] Layer 4: Generating structural summary...");
      const summary = generateStructuralSummary(payload, graph, complexity.mode);

      // ================================================================
      // Layer 5: Multi-pass LLM Understanding
      // ================================================================
      logs.push("[DocAnalyst] Layer 5: Performing multi-pass LLM understanding...");
      const tokenBudget = new TokenBudgetManager(complexity.factors.estimatedTokens);

      const analysisResult = await understandDocument(
        llm,
        payload,
        graph,
        summary,
        complexity.mode,
        tokenBudget
      );

      logs.push(`[DocAnalyst] Analysis result: success=${analysisResult.success}, mode=${analysisResult.mode}, fallback=${analysisResult.fallbackUsed}, confidence=${(analysisResult.overallConfidence * 100).toFixed(1)}%`);

      // ================================================================
      // Layer 7: Analysis Artifacts
      // ================================================================
      logs.push("[DocAnalyst] Layer 7: Building analysis artifacts...");
      const artifacts = buildArtifacts(
        docId,
        payload,
        graph,
        complexity,
        summary,
        analysisResult.layoutUnderstanding,
        analysisResult.sectionUnderstandings,
        analysisResult.fieldUnderstandings,
        analysisResult.fallbackUsed,
        analysisResult.fallbackReason
      );

      const artifactsId = await saveArtifacts(artifacts);
      logs.push(`[DocAnalyst] Artifacts saved: ${artifactsId}`);

      // ================================================================
      // Layer 8: Semantic Document Schema
      // ================================================================
      logs.push("[DocAnalyst] Layer 8: Building semantic document schema...");
      const schema = buildSemanticSchema(artifacts, "minimal");
      const schemaId = await saveSchema(schema);
      logs.push(`[DocAnalyst] Schema saved: ${schemaId}`);

      // 返回 state patch
      return {
        analysisArtifactsId: artifactsId,
        semanticSchemaId: schemaId,
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "DocAnalyst",
        success: true,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logs.push(`[DocAnalyst] Error: ${msg}`);
      console.error("[DocAnalyst] Error:", err);

      return {
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "DocAnalyst",
        success: false,
      };
    }
  };
}

// 重新导出类型
export type {
  SemanticDocumentSchema,
  AnalysisArtifacts,
  CellRole,
  SemanticType,
  WritableConfidence,
  SemanticCell,
  SemanticSection,
  AnalysisMode,
  TraceLevel,
} from "./types";
