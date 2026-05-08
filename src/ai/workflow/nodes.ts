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
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { getWriter } from "@langchain/langgraph";
import type { PhaseStreamStrategy } from "../agent/phaseStrategy";
import { executeTasksStream } from "../tools/executeTool";
import { getToolMetadataByName } from "../tools/sdkTools";
import { AnalysisOutputTool, PlanOutputTool, ValidateOutputTool, ValidateOutputSchema } from "../tools/outputSchemas";
import {
  buildAnalyzePhase, buildPlanPhase, buildValidatePhase,
  generateSystemPrompt,
  ANTI_LEAK_RULES, CLASSIFICATION_RULES, LANGUAGE_RULES,
} from "../prompts";
import { retrieveMemory, manageMemory } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import { AgentState } from "./state";

/* ============================================================== */
/*  analyze 节点（含文档定位）                                    */
/* ============================================================== */

export function createAnalyzeNode(llm: ChatOpenAI, strategy: PhaseStreamStrategy) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig) => {
    // 文档定位（原 docTarget 节点逻辑内联）
    const allDocs = fileRegistry.getAll();
    let targetDocId = state.docId;
    const docContext = fileRegistry.toContextString(targetDocId);

    if (!targetDocId || !fileRegistry.get(targetDocId)) {
      if (allDocs.length === 1) targetDocId = allDocs[0].docId;
      else {
        for (const doc of allDocs) {
          if (state.userInput.includes(doc.originalName)) { targetDocId = doc.docId; break; }
          if (state.userInput.includes(doc.originalName.replace(/\.\w+$/, ""))) { targetDocId = doc.docId; break; }
        }
        targetDocId = targetDocId || allDocs[0]?.docId || "";
      }
    }

    if (!targetDocId) throw new Error("无法确定目标文档");

    const targetDocName = fileRegistry.get(targetDocId)?.originalName || targetDocId;
    const relatedMemory = await retrieveMemory(targetDocId, state.userInput);

    // 分析阶段
    const { thoughtMessages, toolSystemMessage, toolContext } =
      await buildAnalyzePhase({
        classification_rules: CLASSIFICATION_RULES,
        anti_leak_rules: ANTI_LEAK_RULES,
        user_input: state.userInput,
        doc_context: docContext,
        related_memory: relatedMemory,
      });

    const gen = strategy.execute(llm, thoughtMessages, new AnalysisOutputTool(), toolSystemMessage, toolContext);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const analysisObj = r.value || {};

    return {
      docId: targetDocId,
      docContext,
      targetDocName,
      relatedMemory,
      analysis: JSON.stringify(analysisObj),
    };
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
        user_input: state.userInput,
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
/*  validate_plan 节点（Plan 生成后校验）                           */
/* ============================================================== */

export function createValidatePlanNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig) => {
    // 解析分析结果，提取 task_type
    let taskType = "";
    try { taskType = (JSON.parse(state.analysis) as Record<string, unknown>).task_type as string || ""; } catch { /* */ }

    const prompt = `校验以下计划是否匹配用户原始需求：

用户需求: ${state.userInput}
任务类型(LLM判定): ${taskType || "未指定"}
生成的计划: ${state.planJson}
先前错误: ${state.planErrorContext || "无"}

回答以下问题:
1. 计划是否与用户原始需求一致？
2. 如果 task_type 是 "create_new" 或 "template_fill_with_given_data"，计划中是否错误地包含了从其他文档提取信息的任务？
3. 如果用户原始输入包含了明确的键值对数据（如姓名=XXX、电话=XXX、项目名称=XXX），计划中不应包含"从参考文档提取"的步骤——用户已经提供了数据，只需参考模板格式。检查计划中每个任务是否将"用户提供的数据"作为写入目标而非去参考文档查找
4. 如果"参考文档"（如与绘.docx）的数据与用户提供的数据可能不同（参考文档是别人的项目），计划中任务应以用户数据为准，参考文档仅用于定位格式
5. 每个任务是否在当前可用文档(${state.docContext})范围内可执行？

输出 JSON: {"valid": true/false, "reason": "简短原因（无效时必须写明哪个任务有问题）", "suggested_fix": "修正建议"}`;

    try {
      const response = await llm.invoke([new HumanMessage(prompt)]);
      const text = response.content.toString();
      const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}") as Record<string, unknown>;
      const valid = json.valid !== false;
      const reason = (json.reason as string) || "";

      return {
        planValid: valid,
        planErrorContext: reason,
        planRetries: state.planRetries + 1,
        needsUserInput: !valid && state.planRetries >= 1,
      };
    } catch {
      return { planValid: true, planRetries: state.planRetries + 1 };
    }
  };
}

/* ============================================================== */
/*  execute 节点（流式工具调用）                                   */
/* ============================================================== */

export function createExecuteNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const planTasks = (() => { try { return JSON.parse(state.planJson).tasks || []; } catch { return []; } })();
    let allLogs: string[] = [];
    let overallSuccess: boolean | null = null;
    let cachedDocText = state.cachedDocText;
    const writer = getWriter(config);

    // 逐 task 顺序执行（任务隔离，OpenCode 标准模式）
    let taskIdx = 0;
    for (const task of planTasks) {
      const targetName = (task as Record<string, unknown>).target_document as string || "";
      const doc = targetName ? fileRegistry.getByName(targetName) : undefined;
      if (!targetName || !doc) {
        allLogs.push(`[跳过] 任务缺少目标文档: ${JSON.stringify(task).slice(0, 100)}`);
        continue;
      }
      const docEntry = fileRegistry.get(doc.docId);
      const docLabel = docEntry ? `"${docEntry.originalName}" (${doc.docId.slice(0, 8)})` : doc.docId;
      taskIdx++;
      allLogs.push(`--- 任务 ${taskIdx}: ${(task as Record<string, unknown>).goal || ''} [${docLabel}] ---`);

      for await (const event of executeTasksStream(llm, doc.docId, [task])) {
        switch (event.type) {
          case "tool_start": {
            const meta = getToolMetadataByName(event.tool!);
            if (!meta.showInUI) continue;
            let rawArgs: Record<string, unknown> = {};
            if (event.args) { try { rawArgs = JSON.parse(event.args); } catch { rawArgs = {}; } }
            writer?.({ type: "tool_start", data: { tool: meta.displayName, args: meta.argsFormatter(rawArgs), doc: docLabel } });
            break;
          }
          case "tool_result": {
            const meta = getToolMetadataByName(event.tool!);
            if (!meta.showInUI) continue;
            writer?.({ type: "tool_result", data: { success: event.status === "success", tool: meta.displayName, result: event.result || "完成", doc: docLabel } });
            if (event.tool === "sdk_get_text" && event.status === "success" && event.result) {
              const m = event.result.match(/：(.+)/);
              cachedDocText = m ? m[1] : event.result;
            }
            break;
          }
          case "done": {
            allLogs.push(`[文档 ${docLabel}] ${event.executionLog || ""}`);
            if (overallSuccess === null) overallSuccess = event.success ?? null;
            else if (event.success === false) overallSuccess = false;
            break;
          }
        }
      }
    }

    return { executionLog: allLogs.join("\n"), cachedDocText, success: overallSuccess === true };
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
    // 代码层预判：executeNode 已确认全部成功，跳过 LLM 判定
    if (state.success) {
      return { validateJson: "{}", success: true, retryable: false, needsUserInput: false, retryCount: state.retryCount + 1 };
    }

    const { thoughtMessages, toolSystemMessage, toolContext } =
      await buildValidatePhase({
        anti_leak_rules: ANTI_LEAK_RULES,
        execution_log: state.executionLog,
        plan_tasks: state.planJson,
      });

    const gen = strategy.execute(llm, thoughtMessages, new ValidateOutputTool(), toolSystemMessage, toolContext);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const rawObj = r.value as Record<string, unknown> | null;

    // 标准做法：Zod safeParse 验证 LLM 结构化输出（替代裸 as any）
    const parsed = rawObj ? ValidateOutputSchema.safeParse(rawObj) : null;
    const validationResult = parsed?.success
      ? parsed.data
      : {
          result: "失败" as const,
          summary: "",
          retryable: false,
          needs_user_input: false,
          failed_tasks: [] as string[],
          error_analysis: "",
        };

    const success = validationResult.result === "成功";
    const retryable = validationResult.retryable;
    const needsUserInput = validationResult.needs_user_input;

    await manageMemory(state.docId, state.userInput, state.retryCount,
      success ? "成功" : "失败",
      state.analysis, state.planJson, state.executionLog,
      validationResult.failed_tasks || extractFailedSteps(state.executionLog));

    // 标准做法：retryCount 在每次通过 validate 时递增（LangGraph 官方重试模式）
    return {
      validateJson: JSON.stringify(validationResult),
      success,
      retryable,
      needsUserInput,
      retryCount: state.retryCount + 1,
    };
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
