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

function failedDocAnalystPatch(
  state: typeof AgentState.State,
  logs: string[],
  reason: string,
  errorMessage: string,
  stack?: string,
  extra?: Record<string, unknown>,
): Partial<typeof AgentState.State> {
  return {
    executionLog: logs.join("\n"),
    delegationStep: (state.delegationStep ?? 0) + 1,
    lastAgent: "DocAnalyst",
    docAnalystStatus: "failed",
    docAnalystResult: JSON.stringify({
      status: "failed",
      reason,
      errorMessage,
      stack,
      analysis: null,
      ...extra,
    }),
    success: false,
    retryable: false,
    workflowError: "DocAnalyst 分析失败，未生成执行计划",
  };
}

export function createDocAnalystNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
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

        if (
          tableAnalysis.templates.length === 0 ||
          (tableAnalysis.missingSections?.length || 0) > 0 ||
          (tableAnalysis.duplicateTemplateGroups?.length || 0) > 0
        ) {
          logs.push("[DocAnalyst] Failed: no field position templates were extracted from reference document");
          return {
            tableAnalysisId: tableAnalysis.analysisId,
            ...failedDocAnalystPatch(
              state,
              logs,
              tableAnalysis.duplicateTemplateGroups?.length
                ? "DUPLICATE_FIELD_TEMPLATES"
                : tableAnalysis.missingSections?.length
                  ? "SECTION_TEMPLATE_NOT_FOUND"
                  : "NO_FIELD_POSITION_TEMPLATES",
              tableAnalysis.duplicateTemplateGroups?.length
                ? "DocAnalyst 生成了重复目标模板，无法生成安全写入计划。"
                : tableAnalysis.missingSections?.length
                  ? "数组字段缺少 section 模板，无法生成安全写入计划。"
                  : "参考文档未能建立任何字段位置模板，无法生成目标文档写入计划。",
              undefined,
              {
                failedSections: tableAnalysis.failedSections || [],
                missingSections: tableAnalysis.missingSections || [],
                duplicateTemplateGroups: tableAnalysis.duplicateTemplateGroups || [],
              },
            ),
          };
        }

        return {
          tableAnalysisId: tableAnalysis.analysisId,
          executionLog: logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          lastAgent: "DocAnalyst",
          docAnalystStatus: "success",
          docAnalystResult: JSON.stringify({
            status: "success",
            analysis: {
              tableAnalysisId: tableAnalysis.analysisId,
              templateCount: tableAnalysis.templates.length,
              failedSections: tableAnalysis.failedSections || [],
            },
          }),
          success: true,
          workflowError: "",
        };
      }

      logs.push("[DocAnalyst] Layer 1: Parsing document...");
      const payload = await parseDocument(docId, false);

      if (payload.tables.length === 0) {
        logs.push("[DocAnalyst] No tables found in document");
        return failedDocAnalystPatch(
          state,
          logs,
          "NO_TABLES_FOUND",
          "文档中未找到表格。",
        );
      }

      logs.push(`[DocAnalyst] Found ${payload.tables.length} tables, extraction method: ${payload.extractionMethod}, coverage: ${(payload.extractionCoverage * 100).toFixed(1)}%`);

      logs.push("[DocAnalyst] Layer 2: Building spatial graph...");
      const graph = buildSpatialGraph(payload);
      logs.push(`[DocAnalyst] Built graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.sections.length} sections, ${graph.repeatedPatterns.length} patterns`);

      logs.push("[DocAnalyst] Layer 3: Classifying complexity...");
      const complexity = classifyComplexity(payload, graph);
      logs.push(`[DocAnalyst] Complexity: score=${complexity.score.toFixed(2)}, mode=${complexity.mode}, estimatedTokens=${complexity.factors.estimatedTokens}`);

      if (complexity.mode === "complex" && payload.extractionCoverage < 0.7) {
        logs.push("[DocAnalyst] Re-parsing with complex mode...");
        const complexPayload = await parseDocument(docId, true);
        if (complexPayload.extractionCoverage > payload.extractionCoverage) {
          Object.assign(payload, complexPayload);
        }
      }

      logs.push("[DocAnalyst] Layer 4: Generating structural summary...");
      const summary = generateStructuralSummary(payload, graph, complexity.mode);

      logs.push("[DocAnalyst] Layer 5: Performing multi-pass LLM understanding...");
      const tokenBudget = new TokenBudgetManager(complexity.factors.estimatedTokens);
      const analysisResult = await understandDocument(
        llm,
        payload,
        graph,
        summary,
        complexity.mode,
        tokenBudget,
      );

      logs.push(`[DocAnalyst] Analysis result: success=${analysisResult.success}, mode=${analysisResult.mode}, fallback=${analysisResult.fallbackUsed}, confidence=${(analysisResult.overallConfidence * 100).toFixed(1)}%`);

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
        analysisResult.fallbackReason,
      );

      const artifactsId = await saveArtifacts(artifacts);
      logs.push(`[DocAnalyst] Artifacts saved: ${artifactsId}`);

      logs.push("[DocAnalyst] Layer 8: Building semantic document schema...");
      const schema = buildSemanticSchema(artifacts, "minimal");
      const schemaId = await saveSchema(schema);
      logs.push(`[DocAnalyst] Schema saved: ${schemaId}`);

      return {
        analysisArtifactsId: artifactsId,
        semanticSchemaId: schemaId,
        executionLog: logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        lastAgent: "DocAnalyst",
        docAnalystStatus: "success",
        docAnalystResult: JSON.stringify({
          status: "success",
          analysis: { schemaId, artifactsId },
        }),
        success: true,
        workflowError: "",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logs.push(`[DocAnalyst] Error: ${msg}`);
      console.error("[DocAnalyst] Error:", err);

      return failedDocAnalystPatch(
        state,
        logs,
        "DOC_ANALYST_EXCEPTION",
        msg,
        err instanceof Error ? err.stack : undefined,
      );
    }
  };
}

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
