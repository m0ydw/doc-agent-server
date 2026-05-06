/**
 * ================================================================
 * GlobalAgent — 全局 LLM Agent（单例）
 * ================================================================
 *
 * 【职责】
 *   服务启动时创建，常驻内存，跨请求保持记忆。
 *   多文档感知：通过 FileRegistry 知道所有可用文档。
 *   接收前端消息 → 驱动 LangChain 工作流 → SSE 流式输出。
 *
 * 【架构概览 — LLM ↔ Agent ↔ SDK 完整调用链】
 * ┌─────────────────────────────────────────────────────────────┐
 * │                                                             │
 * │  HTTP POST /api/ai/agent/message                            │
 * │    │                                                        │
 * │    ▼                                                        │
 * │  aiRoutes.ts (路由)                                         │
 * │    │                                                        │
 * │    ▼                                                        │
 * │  aiService.ts (SSE 输出封装)                                 │
 * │    │                                                        │
 * │    ▼                                                        │
 * │  GlobalAgent.streamProcess()  ←── 你在这里                  │
 * │    │                                                        │
 * │    ├── 1. 解析用户输入 + 确定目标文档                        │
 * │    │     调用 fileRegistry 获取文档信息                       │
 * │    │                                                        │
 * │    ├── 2. Analyze 阶段 (runPhase)                            │
 * │    │     ChatOpenAI.stream() → 分析用户需求                  │
 * │    │     输出: { intent, operations, context_hints }        │
 * │    │                                                        │
 * │    ├── 3. Plan 阶段 (runPhase)                               │
 * │    │     ChatOpenAI.stream() → 制定语义化任务清单             │
 * │    │     输出: { tasks: [{ goal, description, constraints }]}│
 * │    │                                                        │
 * │    ├── 4. Execute 阶段 (LLM 驱动)                            │
 * │    │     ExecuteTool (内部 LLM + SDK Tools)                  │
 * │    │     ┌─ sdk_find_text    → editor.findText()            │
 * │    │     ├─ sdk_replace_text → editor.replaceFirst()        │
 * │    │     ├─ sdk_replace_all  → editor.replaceAll()           │
 * │    │     ├─ sdk_get_text     → editor.getText()             │
 * │    │     └─ sdk_save         → sessionManager → doc.save()  │
 * │    │                                                        │
 * │    ├── 5. Validate 阶段 (runPhase)                           │
 * │    │     ChatOpenAI.stream() → 验证执行结果                  │
 * │    │     输出: { result, retryable, needs_user_input }      │
 * │    │                                                        │
 * │    └── 6. 重试决策 + 记忆保存                                │
 * │          成功 → 结束 | 失败且可重试 → 回到第2步              │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 【SSE 流式策略】
 *   - Analyze/Plan/Validate 阶段: 通过 PhaseStreamStrategy 实现
 *     token 级别流式 + 结构化 JSON 双通道
 *   - Execute 阶段: ExecuteTool 内部使用 LLM tool calling 循环，
 *     外部只输出执行日志（不需要逐 token 流式）
 *
 * 【重构改进项一览（v2）】
 *   0. DualCallStrategy 抽象为可替换策略（phaseStrategy.ts）
 *   1. var → const/let（全文件）
 *   2. 三阶段循环 → runPhase() 一行调用（phaseRunner.ts）
 *   3. executeTool._call() → invoke() + 解析函数抽离（executeTool.ts）
 *   4. 硬编码 TOOL_DISPLAY → getToolMetadata() 动态读取（sdkTools.ts）
 *   5. 结构化输出失败时 yield [warning] 事件 + console.warn
 *   6. Record<string,any> → AnalysisResult / PlanResult / ValidateResult（types.ts）
 *   7. 散落 formatMessages → buildXxxPhase() 工厂函数（prompts/*.ts）
 * ================================================================
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { createChatModel } from "../core/llm";
import type { LLMProvider } from "../core/llm";
import { ExecuteTool } from "../tools/executeTool";
import { parseExecuteResult, extractDocSnippet } from "../tools/executeTool";
import type { SDKToolMetadata } from "../tools/sdkTools";
import { SDK_TOOL_METADATA } from "../tools/sdkTools";
import { AnalysisOutputTool, PlanOutputTool, ValidateOutputTool } from "../tools/outputSchemas";
import {
  buildAnalyzePhase, buildPlanPhase, buildValidatePhase,
  generateSystemPrompt, chatSystemPrompt,
  ANTI_LEAK_RULES, CLASSIFICATION_RULES, LANGUAGE_RULES,
} from "../prompts";
import { runPhase } from "./phaseRunner";
import { createPhaseStrategy, streamWithCutting } from "./phaseStrategy";
import { ssePhaseStart, ssePhaseStatus, ssePhaseEnd, sseDocTarget, sseContent, sseChat, sseToolStart, sseToolResult, sseSummary, sseError, sseTodoList, sseTodoDone } from "../core/sseEmitter";
import type { PhaseStreamStrategy } from "./phaseStrategy";
import type { AnalysisResult, PlanResult, ValidateResult, PhaseConfig } from "./types";
import { retrieveMemory, manageMemory, clearMemories, getMemories } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import editor from "../../services/editor";

/** 最大重试次数 */
const MAX_RETRY = 3;

/** 文档文本截断长度（Chat 模式传给 LLM 的最大字符数） */
const MAX_DOC_CONTEXT_CHARS = 4000;

/** executeTool 返回的文档片段最大长度 */
const MAX_DOC_SNIPPET_CHARS = 4000;

/**
 * 内容查询关键词语义模式（改进项 #13）
 * TODO: 未来改为依赖 Analyze 阶段的 intent 字段路由，而非正则匹配
 */
const CONTENT_QUERY_PATTERN = /总结|分析|概述|介绍|是什么|讲了什么|写了什么|有哪些|概括|说明|描述|评价/i;
const MODIFY_PATTERN = /替换|修改|删除|插入|加粗|改成|换成|删掉|去掉|添加|新增|追加/i;

/** 初始化配置 */
export interface GlobalAgentConfig {
  provider?: LLMProvider;  // zhipu | deepseek | openai（不填则自动推断）
  apiKey?: string;
  modelName?: string;
  temperature?: number;
  modelKwargs?: Record<string, unknown>;
}

/** streamProcess 参数 */
export interface ProcessParams {
  message: string;
  contextDocId?: string;
  mode?: "workflow" | "chat";
}

// ================================================================
// 全局 Agent 类
// ================================================================

class GlobalAgent {
  private llm: ChatOpenAI | null = null;
  private initialized = false;
  private phaseStrategy: PhaseStreamStrategy | null = null;

  /** 检测 llm 是否可用的 getter */
  get isInitialized(): boolean {
    return this.initialized && this.llm !== null;
  }

  /**
   * 初始化 Agent（从 .env 自动读取配置）
   */
  initialize(config?: GlobalAgentConfig): void {
    if (this.initialized) return;

    const apiKey = config?.apiKey || process.env.ZHIPUAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("[GlobalAgent] 未配置 API Key，Agent 无法工作。请在 .env 中设置 ZHIPUAI_API_KEY 或 DEEPSEEK_API_KEY");
      return;
    }

    // 自动推断 provider
    let provider: LLMProvider = config?.provider || "zhipu";
    if (!config?.provider) {
      if (apiKey === process.env.DEEPSEEK_API_KEY) provider = "deepseek";
      else if (apiKey === process.env.OPENAI_API_KEY) provider = "openai";
    }

    const modelName = config?.modelName;
    this.llm = createChatModel({
      provider,
      apiKey,
      modelName,
      temperature: config?.temperature ?? 0.1,
      modelKwargs: config?.modelKwargs,
    });

    // 创建流式策略（改进项 0）
    this.phaseStrategy = createPhaseStrategy(modelName);

    this.initialized = true;
    console.log("[GlobalAgent] LLM 初始化完成: provider=" + provider +
                ", model=" + (modelName || "default") +
                ", strategy=" + this.phaseStrategy.name);
  }

  /**
   * 重新初始化 Agent（切换模型时调用）
   */
  reinitialize(config?: GlobalAgentConfig): void {
    this.llm = null;
    this.phaseStrategy = null;
    this.initialized = false;
    this.initialize(config);
  }

  // ============================================================
  // Chat 模式 — 直接对话回答
  // ============================================================

  /**
   * Chat 模式：直接对话回答（无阶段流水线）
   *
   * 流程：
   *   1. 读取文档文本（通过 SDK）
   *   2. 构建对话 prompt（文档内容 + 用户问题）
   *   3. LLM 流式输出 chat 事件
   */
  private async *runChatMode(
    docId: string,
    docName: string,
    userInput: string,
    _docContext: string
  ): AsyncGenerator<string, void, unknown> {
    // 1. 读取文档文本
    yield sseToolStart("读取文档", "获取文档内容");
    let docText = "";
    try {
      docText = await editor.getText(docId);
      yield sseToolResult(true, "读取文档", "文档全文（" + docText.length + " 字符）");
    } catch (e: any) {
      yield sseToolResult(false, "读取文档", "读取失败：" + (e.message || "未知错误"));
      yield sseError("无法读取文档内容，请检查文档是否正常打开");
      return;
    }

    // 2. 构建对话 prompt
    const chatMessages = await chatSystemPrompt.formatMessages({
      doc_name: docName,
      language_rules: LANGUAGE_RULES,
      user_input: userInput,
      doc_text: docText.substring(0, MAX_DOC_CONTEXT_CHARS) + (docText.length > MAX_DOC_CONTEXT_CHARS ? "\n（文档较长，以上为前 " + MAX_DOC_CONTEXT_CHARS + " 字符）" : ""),
    });

    // 3. 流式输出对话内容
    const chatStream = await this.llm!.stream(chatMessages);
    yield* streamWithCutting(chatStream, sseChat);

    // 4. 结束
    yield sseSummary({
      result: "success",
      summary_text: "",
      detail: "",
      failed_tasks: [],
    });
  }

  // ============================================================
  // 核心：streamProcess — 处理用户消息，SSE 流式返回
  // ============================================================

  /**
   * 处理用户消息，SSE 流式返回
   *
   * 【流式输出策略】
   *   Analyze / Plan / Validate 阶段 → 使用 PhaseStreamStrategy + runPhase
   *   Execute 阶段 → 使用 ExecuteTool（内部 LLM + SDK Tools）
   *
   * 【SSE 事件格式】
   *   [phase]xxx      → 阶段状态
   *   [thought]xxx    → 思考过程（逐片）
   *   [content]xxx    → 用户可见内容
   *   [tool_start]... → 工具调用开始
   *   [tool_result]...→ 工具执行结果
   *   [summary]{json} → 最终总结
   *   [warning]xxx    → 降级通知（新增，改进项5）
   *   [error]xxx      → 错误
   */
  async *streamProcess(params: ProcessParams): AsyncGenerator<string, void, unknown> {
    if (!this.initialized || !this.llm || !this.phaseStrategy) {
      yield sseError("Agent 未初始化，请先配置 API Key");
      return;
    }

    const userInput = params.message;
    const contextDocId = params.contextDocId;
    const docContext = fileRegistry.toContextString(contextDocId);
    const mode = params.mode || "workflow";

    // 确定目标文档
    const targetDocId = this.resolveTargetDocId(userInput, contextDocId);
    if (!targetDocId) {
      yield sseError("无法确定目标文档，请先上传 .docx 文件");
      return;
    }

    const targetName = (fileRegistry.get(targetDocId)?.originalName) || targetDocId;
    yield sseDocTarget(targetName);

    // ============ Chat 模式：直接对话回答 ============
    if (mode === "chat") {
      yield* this.runChatMode(targetDocId, targetName, userInput, docContext);
      return;
    }

    // ============ 内容查询自动路由 === 纯查询 → Chat 模式 ===
    if (CONTENT_QUERY_PATTERN.test(userInput) && !MODIFY_PATTERN.test(userInput)) {
      console.log("[GlobalAgent] 检测到纯内容查询，路由到 Chat 模式");
      yield* this.runChatMode(targetDocId, targetName, userInput, docContext);
      return;
    }

    // ============ Workflow 模式：多阶段流水线 ==========
    let retryCount = 0;
    let cachedDocText = "";  // 文本缓存，避免重复 SDK 读取
    const llm = this.llm;
    const strategy = this.phaseStrategy;

    while (retryCount < MAX_RETRY) {
      const relatedMemory = retrieveMemory(targetDocId, userInput);

      // ============================================================
      // 阶段1: Analyze — 使用 runPhase（改进项 2, 7）
      // ============================================================
      yield ssePhaseStatus("正在分析您的需求...");

      const analyzeObj: AnalysisResult | null = yield* runPhase<AnalysisResult>(
        llm,
        strategy,
        {
          phaseName: "analyze",
          promptBuilder: async () => buildAnalyzePhase({
            classification_rules: CLASSIFICATION_RULES,
            anti_leak_rules: ANTI_LEAK_RULES,
            user_input: userInput,
            doc_context: docContext,
            related_memory: relatedMemory,
          }),
          outputTool: new AnalysisOutputTool(),
          summaryBuilder: generateAnalysisSummary,
          fallbackJson: "{}",
        }
      );

      const cleanAnalysis = analyzeObj && typeof analyzeObj === "object"
        ? JSON.stringify(analyzeObj)
        : "{}";

      // ============================================================
      // 阶段2: Plan — 使用 runPhase（改进项 2, 7）
      // ============================================================
      yield ssePhaseStatus("正在制定执行计划...");

      const planObj: PlanResult | null = yield* runPhase<PlanResult>(
        llm,
        strategy,
        {
          phaseName: "plan",
          promptBuilder: async () => buildPlanPhase({
            anti_leak_rules: ANTI_LEAK_RULES,
            clean_analysis: cleanAnalysis,
            doc_context: docContext,
            doc_snippet: cachedDocText ? cachedDocText.substring(0, 2000) : "",
          }),
          outputTool: new PlanOutputTool(),
          summaryBuilder: generatePlanSummary,
          fallbackJson: '{"tasks":[]}',
        }
      );

      const cleanPlan = planObj && typeof planObj === "object"
        ? JSON.stringify(planObj)
        : '{"tasks":[]}';

      // 发射 todo 列表
      if (planObj && planObj.tasks && Array.isArray(planObj.tasks) && planObj.tasks.length > 0) {
        const todoItems = planObj.tasks
          .filter((t) => {
            const goal = (t.goal || t.description || "").toLowerCase();
            return !goal.includes("保存") && !goal.includes("储存") && !goal.includes("存储");
          })
          .map((t) => ({ id: t.id || "", goal: t.goal || t.description || "" }));
        yield sseTodoList(todoItems);
      }

      // ============================================================
      // 阶段3: Execute — LLM 驱动执行（改进项 3, 4）
      // ============================================================
      yield ssePhaseStatus("正在处理文档...");

      const executeTool = new ExecuteTool(this.llm);
      // 改进项 3：使用 invoke() 替代 _call()
      const executeResultStr = await executeTool.invoke({
        plan_tasks: cleanPlan,
        docId: targetDocId,
      }) as string;

      // 改进项 3：使用抽离的解析函数
      const { executionLog, toolCalls, success: executeSuccess } = parseExecuteResult(executeResultStr);

      // 逐个 yield tool 事件（改进项 4：使用 getToolMetadata 动态读取）
      for (const tc of toolCalls) {
        const meta: SDKToolMetadata = SDK_TOOL_METADATA[tc.tool] || {
          displayName: tc.tool,
          argsFormatter: () => "",
          showInUI: true,
        };
        if (!meta.showInUI) continue;  // 替代原来的 if (tc.tool === "sdk_save") continue

        let rawArgs: Record<string, unknown> = {};
        if (typeof tc.args === "string") {
          try { rawArgs = JSON.parse(tc.args); } catch { rawArgs = {}; }
        } else if (tc.args && typeof tc.args === "object") {
          rawArgs = tc.args as Record<string, unknown>;
        }

        const dispArgs = meta.argsFormatter(rawArgs);
        yield sseToolStart(meta.displayName, dispArgs);
        // 微延迟模拟流式工具执行
        await new Promise(r => setTimeout(r, 150));
        yield sseToolResult(
          tc.status === "success",
          meta.displayName,
          tc.result || "完成"
        );

        // 缓存文档文本
        if (tc.tool === "sdk_get_text" && tc.status === "success" && tc.result) {
          const textMatch = tc.result.match(/：(.+)/);
          cachedDocText = textMatch ? textMatch[1] : tc.result;
        }
      }

      yield ssePhaseEnd("execute");

      // ============================================================
      // 阶段4: Generate — 基于执行结果生成用户可见的回答
      // ============================================================
      yield ssePhaseStatus("正在生成回答...");

      // 改进项 3：使用抽离的 extractDocSnippet 函数
      const docSnippet = extractDocSnippet(executeResultStr, MAX_DOC_SNIPPET_CHARS);

      const generateMessages = await generateSystemPrompt.formatMessages({
        language_rules: LANGUAGE_RULES,
        user_input: userInput,
        execution_summary: executionLog.split("\n").slice(0, 10).join("\n"),
        doc_snippet: docSnippet || "（无文档内容）",
      });

      // 流式输出生成内容
      const generateStream = await this.llm.stream(generateMessages);
      yield* streamWithCutting(generateStream, sseContent);
      yield ssePhaseEnd("generate");

      // ============================================================
      // 阶段5: Validate — 使用 runPhase（改进项 2, 7）
      // ============================================================
      yield ssePhaseStatus("正在验证结果...");

      const validateObj: ValidateResult | null = yield* runPhase<ValidateResult>(
        llm,
        strategy,
        {
          phaseName: "validate",
          promptBuilder: async () => buildValidatePhase({
            anti_leak_rules: ANTI_LEAK_RULES,
            execution_log: executionLog,
            plan_tasks: cleanPlan,
          }),
          outputTool: new ValidateOutputTool(),
          summaryBuilder: generateValidateSummary,
          fallbackJson: '{"result":"成功","summary":"","retryable":false,"needs_user_input":false}',
        }
      );

      // ============================================================
      // 解析验证结果（类型安全的属性访问，改进项 6）
      // ============================================================
      let success = false;
      let retryable = true;
      let needsUserInput = false;
      let validateSummary = "";
      let failedTasks: string[] = [];

      if (validateObj && typeof validateObj === "object") {
        success = validateObj.result === "成功";
        retryable = validateObj.retryable !== false;
        needsUserInput = validateObj.needs_user_input === true;
        validateSummary = validateObj.summary || validateObj.result || "";
        failedTasks = validateObj.failed_tasks || [];
      } else {
        // 结构化回退：从 ExecuteResult.success 字段推断（替代字符串匹配）
        console.warn("[GlobalAgent] Validate 返回 null，使用 ExecuteResult.success 回退");
        if (executeSuccess === true) {
          success = true;
          retryable = false;
          validateSummary = "执行完成（ExecuteResult 确认）";
        } else if (executeSuccess === false) {
          success = false;
          retryable = true;
          validateSummary = "执行异常（ExecuteResult 确认）";
        } else {
          // 无法确定 → 标记为 unknown，触发人工介入
          success = false;
          retryable = false;
          needsUserInput = true;
          validateSummary = "无法自动验证执行结果，需要人工确认";
        }
      }

      // 提取失败步骤
      const failedSteps = this.extractFailedSteps(executionLog);

      // 保存记忆
      manageMemory(
        targetDocId, userInput, retryCount,
        success ? "成功" : "失败",
        cleanAnalysis, cleanPlan, executionLog, failedSteps
      );

      // ============================================================
      // Summary 总结
      // ============================================================
      let summary: Record<string, unknown> = {};

      if (success) {
        summary = {
          result: "success",
          summary_text: "✅ 所有任务执行完成",
          detail: validateSummary || "操作已成功执行",
          failed_tasks: [],
        };
        yield sseSummary(summary);
        return;
      }

      if (needsUserInput || !retryable) {
        summary = {
          result: "intervention",
          summary_text: "⚠️ 需要用户介入",
          detail: validateSummary || "请提供更多信息或确认操作",
          failed_tasks: failedTasks.length > 0 ? failedTasks : failedSteps,
        };
        yield sseSummary(summary);
        return;
      }

      // 可重试
      retryCount++;
      if (retryCount < MAX_RETRY) {
        summary = {
          result: "retry",
          summary_text: "🔄 第" + retryCount + "次重试",
          detail: validateSummary || "执行失败，正在重试",
          failed_tasks: failedTasks.length > 0 ? failedTasks : failedSteps,
        };
        yield sseSummary(summary);
      } else {
        summary = {
          result: "failed",
          summary_text: "❌ 重试" + MAX_RETRY + "次仍然失败",
          detail: validateSummary || "请检查文档是否存在或提供更多信息",
          failed_tasks: failedTasks.length > 0 ? failedTasks : failedSteps,
        };
        yield sseSummary(summary);
      }
    }
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /**
   * 从执行日志中提取失败步骤
   */
  private extractFailedSteps(executionLog: string): string[] {
    const failed: string[] = [];
    const lines = executionLog.split("\n");
    for (const line of lines) {
      if (line.indexOf("[工具]") >= 0 && line.indexOf("失败") >= 0) {
        const match = line.match(/\[工具\]\s*(\w+)/);
        if (match) failed.push(match[1]);
      }
    }
    return failed;
  }

  /**
   * 确定目标文档 ID
   */
  private resolveTargetDocId(userInput: string, contextDocId?: string): string | undefined {
    const allDocs = fileRegistry.getAll();
    if (allDocs.length === 0) return undefined;
    if (allDocs.length === 1) return allDocs[0].docId;

    for (const doc of allDocs) {
      if (userInput.indexOf(doc.originalName) >= 0) return doc.docId;
      const shortName = doc.originalName.replace(/\.\w+$/, "");
      if (userInput.indexOf(shortName) >= 0) return doc.docId;
    }
    if (contextDocId && fileRegistry.get(contextDocId)) return contextDocId;
    return allDocs[0].docId;
  }

  /**
   * 重置记忆
   */
  reset(): void {
    clearMemories();
    console.log("[GlobalAgent] 记忆已重置");
  }

  /**
   * 获取当前状态
   */
  getStatus(): { initialized: boolean; docCount: number; memoryLength: number } {
    return {
      initialized: this.initialized,
      docCount: fileRegistry.count,
      memoryLength: getMemories().length,
    };
  }
}

// ================================================================
// 阶段摘要生成器（改进项 6：类型守卫 + 明确类型）
// ================================================================

/**
 * 生成 Analyze 阶段的用户友好摘要
 */
function generateAnalysisSummary(data: AnalysisResult): string {
  const { intent, operations: ops } = data;

  // 内容查询意图
  if (intent === "content_query" || (ops.length > 0 && ops[0].type === "query")) {
    const queryGoal = ops[0]?.goal || "了解文档内容";
    return "用户想了解：" + queryGoal;
  }

  // 修改操作意图
  if (ops.length === 0) return "未识别到具体操作";
  let summary = "已识别 " + ops.length + " 个操作：";
  for (const op of ops) {
    summary += "\n  • " + (op.goal || op.type || "");
  }
  return summary;
}

/**
 * 生成 Plan 阶段的用户友好摘要
 */
function generatePlanSummary(data: PlanResult): string {
  const { tasks } = data;
  if (tasks.length === 0) return "未生成任务计划";
  let summary = "已制定 " + tasks.length + " 项任务：";
  for (const t of tasks) {
    summary += "\n  • " + (t.goal || "");
  }
  return summary;
}

/**
 * 生成 Validate 阶段的用户友好摘要
 */
function generateValidateSummary(data: ValidateResult): string {
  return data.summary || data.result || "验证完成";
}

// ================================================================
// 全局单例管理
// ================================================================

let globalAgent: GlobalAgent | null = null;

/**
 * 初始化全局 Agent
 * 在 server.ts 启动时调用
 */
export async function initGlobalAgent(config?: GlobalAgentConfig): Promise<void> {
  if (globalAgent) {
    console.log("[GlobalAgent] 已存在，跳过初始化");
    return;
  }
  globalAgent = new GlobalAgent();
  globalAgent.initialize(config);
}

/**
 * 获取全局 Agent 实例
 */
export function getGlobalAgent(): GlobalAgent {
  if (!globalAgent) {
    globalAgent = new GlobalAgent();
    console.warn("[GlobalAgent] 未初始化就调用 getGlobalAgent()，返回未初始化实例");
  }
  return globalAgent;
}

/**
 * 重置全局 Agent
 */
export function resetGlobalAgent(): void {
  if (globalAgent) {
    globalAgent.reset();
  }
}
