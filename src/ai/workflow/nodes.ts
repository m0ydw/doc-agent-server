/**
 * ================================================================
 * LangGraph 工作流节点（纯状态转换）
 * ================================================================
 *
 * 【SSE 事件由谁发射？】
 *   - on_chat_model_stream  → wsAgentHandler 映射为 thought/content
 *   - on_chain_start        → wsAgentHandler 映射为 phase_start/status
 *   - on_chain_end          → wsAgentHandler 映射为 phase_end
 *   - tool_start/result     → 节点内 getWriter 发射（WS handler 无法生成）
 *   - doc_target            → on_chain_end(docTarget) 状态输出
 */

import { ChatOpenAI } from "@langchain/openai";
import { RunnableConfig } from "@langchain/core/runnables";
import { BaseMessage } from "@langchain/core/messages";
import { getWriter } from "@langchain/langgraph";
import type { PhaseStreamStrategy } from "../agent/phaseStrategy";
import { executeTasksStream } from "../tools/executeTool";
import { getToolMetadataByName } from "../tools/sdkTools";
import { AnalysisOutputTool, PlanOutputTool, ValidateOutputTool } from "../tools/outputSchemas";
import {
  buildAnalyzePhase, buildPlanPhase, buildValidatePhase,
  generateSystemPrompt,
  ANTI_LEAK_RULES, CLASSIFICATION_RULES, LANGUAGE_RULES,
} from "../prompts";
import { retrieveMemory, manageMemory } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import { AgentState } from "./state";

/* ============================================================== */
/*  docTarget 节点                                                */
/* ============================================================== */

export function createDocTargetNode(_llm: ChatOpenAI, _strategy: PhaseStreamStrategy) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig) => {
    const userInput = state.userInput;
    const contextDocId = state.docId;
    const allDocs = fileRegistry.getAll();
    const docContext = fileRegistry.toContextString(contextDocId);

    let targetDocId: string | undefined;
    if (allDocs.length === 1) targetDocId = allDocs[0].docId;
    else {
      for (const doc of allDocs) {
        if (userInput.includes(doc.originalName)) { targetDocId = doc.docId; break; }
        if (userInput.includes(doc.originalName.replace(/\.\w+$/, ""))) { targetDocId = doc.docId; break; }
      }
      targetDocId = targetDocId || (contextDocId && fileRegistry.get(contextDocId) ? contextDocId : allDocs[0]?.docId);
    }

    if (!targetDocId) throw new Error("无法确定目标文档");

    return {
      docId: targetDocId,
      docContext,
      targetDocName: fileRegistry.get(targetDocId)?.originalName || targetDocId,
      relatedMemory: retrieveMemory(targetDocId, userInput),
    };
  };
}

/* ============================================================== */
/*  analyze 节点                                                   */
/* ============================================================== */

export function createAnalyzeNode(llm: ChatOpenAI, strategy: PhaseStreamStrategy) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig) => {
    const { thoughtMessages, toolSystemMessage, toolContext } =
      await buildAnalyzePhase({
        classification_rules: CLASSIFICATION_RULES,
        anti_leak_rules: ANTI_LEAK_RULES,
        user_input: state.userInput,
        doc_context: state.docContext,
        related_memory: state.relatedMemory,
      });

    const gen = strategy.execute(llm, thoughtMessages, new AnalysisOutputTool(), toolSystemMessage, toolContext);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const analysisObj = r.value || {};

    return { analysis: JSON.stringify(analysisObj) };
  };
}

/* ============================================================== */
/*  plan 节点                                                      */
/* ============================================================== */

export function createPlanNode(llm: ChatOpenAI, strategy: PhaseStreamStrategy) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig) => {
    const { thoughtMessages, toolSystemMessage, toolContext } =
      await buildPlanPhase({
        anti_leak_rules: ANTI_LEAK_RULES,
        clean_analysis: state.analysis,
        doc_context: state.docContext,
        doc_snippet: state.cachedDocText || "",
      });

    const gen = strategy.execute(llm, thoughtMessages, new PlanOutputTool(), toolSystemMessage, toolContext);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const planObj = r.value || { tasks: [] };

    return { planJson: JSON.stringify(planObj) };
  };
}

/* ============================================================== */
/*  execute 节点（流式工具调用）                                   */
/* ============================================================== */

export function createExecuteNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const planTasks = (() => { try { return JSON.parse(state.planJson).tasks || []; } catch { return []; } })();
    let executionLog = "";
    let executeSuccess: boolean | null = null;
    let cachedDocText = state.cachedDocText;
    const writer = getWriter(config);

    for await (const event of executeTasksStream(llm, state.docId, planTasks)) {
      switch (event.type) {
        case "tool_start": {
          const meta = getToolMetadataByName(event.tool!);
          if (!meta.showInUI) continue;
          let rawArgs: Record<string, unknown> = {};
          if (event.args) { try { rawArgs = JSON.parse(event.args); } catch { rawArgs = {}; } }
          writer?.({ type: "tool_start", data: { tool: meta.displayName, args: meta.argsFormatter(rawArgs) } });
          break;
        }
        case "tool_result": {
          const meta = getToolMetadataByName(event.tool!);
          if (!meta.showInUI) continue;
          writer?.({ type: "tool_result", data: { success: event.status === "success", tool: meta.displayName, result: event.result || "完成" } });
          if (event.tool === "sdk_get_text" && event.status === "success" && event.result) {
            const m = event.result.match(/：(.+)/);
            cachedDocText = m ? m[1] : event.result;
          }
          break;
        }
        case "done": {
          executionLog = event.executionLog || "";
          executeSuccess = event.success ?? null;
          break;
        }
      }
    }

    return { executionLog, cachedDocText, success: executeSuccess === true };
  };
}

/* ============================================================== */
/*  generate 节点                                                  */
/* ============================================================== */

export function createGenerateNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig) => {
    const docSnippet = (state.cachedDocText || "").length > 4000
      ? state.cachedDocText.substring(0, 4000) + "..."
      : state.cachedDocText || "（无文档内容）";

    const messages = await generateSystemPrompt.formatMessages({
      language_rules: LANGUAGE_RULES,
      user_input: state.userInput,
      execution_summary: state.executionLog.split("\n").slice(0, 10).join("\n"),
      doc_snippet: docSnippet,
    });

    const stream = await llm.stream(messages);
    for await (const _ of stream) { /* tokens flow via on_chat_model_stream in WS handler */ }

    return {};
  };
}

/* ============================================================== */
/*  validate 节点                                                  */
/* ============================================================== */

export function createValidateNode(llm: ChatOpenAI, strategy: PhaseStreamStrategy) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig) => {
    const { thoughtMessages, toolSystemMessage, toolContext } =
      await buildValidatePhase({
        anti_leak_rules: ANTI_LEAK_RULES,
        execution_log: state.executionLog,
        plan_tasks: state.planJson,
      });

    const gen = strategy.execute(llm, thoughtMessages, new ValidateOutputTool(), toolSystemMessage, toolContext);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const validateObj = r.value as Record<string, unknown> | null;

    manageMemory(state.docId, state.userInput, state.retryCount,
      (validateObj as any)?.result === "成功" ? "成功" : "失败",
      state.analysis, state.planJson, state.executionLog,
      extractFailedSteps(state.executionLog));

    const success = (validateObj as any)?.result === "成功";
    const retryable = (validateObj as any)?.retryable !== false;
    const needsUserInput = (validateObj as any)?.needs_user_input === true;

    if (!validateObj && state.success) {
      return { validateJson: "{}", success: true, retryable: false, needsUserInput: false };
    }

    return { validateJson: JSON.stringify(validateObj), success, retryable, needsUserInput };
  };
}

/* ============================================================== */
/*  辅助函数                                                       */
/* ============================================================== */

function extractFailedSteps(log: string): string[] {
  const failed: string[] = [];
  for (const line of log.split("\n")) {
    if (line.includes("执行失败")) {
      const m = line.match(/sdk_(\w+)/);
      if (m) failed.push(m[1]);
    }
  }
  return failed;
}
