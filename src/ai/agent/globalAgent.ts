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
 * │    ├── 2. Analyze 阶段 (LLM 流式)                            │
 * │    │     ChatOpenAI.stream() → 分析用户需求                  │
 * │    │     输出: { intent, operations, context_hints }        │
 * │    │                                                        │
 * │    ├── 3. Plan 阶段 (LLM 流式)                               │
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
 * │    ├── 5. Validate 阶段 (LLM 流式)                           │
 * │    │     ChatOpenAI.stream() → 验证执行结果                  │
 * │    │     输出: { result, retryable, needs_user_input }      │
 * │    │                                                        │
 * │    └── 6. 重试决策 + 记忆保存                                │
 * │          成功 → 结束 | 失败且可重试 → 回到第2步              │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 【SSE 流式策略】
 *   - Analyze/Plan/Validate 阶段: 直接使用 ChatOpenAI.stream()
 *     实现 token 级别的流式输出
 *   - Execute 阶段: ExecuteTool 内部使用 LLM tool calling 循环，
 *     外部只输出执行日志（不需要逐 token 流式）
 *
 * 【与旧版 GlobalAgent 的区别】
 *   旧版: 自定义 LLM 接口 + 手写 axios + 手写工具类 + 手写编排
 *   新版: ChatOpenAI + StructuredTool + 工作流 + 标准化记忆
 * ================================================================
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { createChatModel } from "../core/llm";
import type { LLMProvider } from "../core/llm";
import { AnalyzeTool, PlanTool, ExecuteTool, ValidateTool } from "../tools";
import { AnalysisOutputTool, PlanOutputTool, ValidateOutputTool } from "../tools/outputSchemas";
import {
  analyzeThoughtPrompt, analyzeToolPrompt,
  planThoughtPrompt, planToolPrompt,
  validateThoughtPrompt, validateToolPrompt,
  generateSystemPrompt, chatSystemPrompt,
  ANTI_LEAK_RULES, CLASSIFICATION_RULES, LANGUAGE_RULES,
} from "../prompts";
import { retrieveMemory, manageMemory, clearMemories, getMemories } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import editor from "../../services/editor";

/** 最大重试次数 */
const MAX_RETRY = 3;

/**
 * 工具显示名映射 — 用于 SSE 事件中隐藏内部工具名
 * 拓展：新增 SDK 工具只需在此追加一条映射即可
 */
const TOOL_DISPLAY: Record<string, { name: string; args: (a: Record<string, any>) => string }> = {
  sdk_find_text:   { name: "搜索文本",  args: a => `搜索 "${a.pattern}"` },
  sdk_replace_text:{ name: "替换文本",  args: a => `将 "${a.target}" 替换为 "${a.replacement}"` },
  sdk_replace_all: { name: "批量替换",  args: a => `将所有 "${a.target}" 替换为 "${a.replacement}"` },
  sdk_get_text:    { name: "读取文档",  args: () => "获取文档全文" },
  sdk_save:        { name: "保存更改",  args: () => "保存文档修改" },
};

/** 初始化配置 */
export interface GlobalAgentConfig {
  provider?: LLMProvider;  // zhipu | deepseek | openai（不填则自动推断）
  apiKey?: string;
  modelName?: string;
  temperature?: number;
}

/** streamProcess 参数 */
export interface ProcessParams {
  message: string;
  contextDocId?: string;
  mode?: "workflow" | "chat";
}

// ================================================================
// Analyze/Plan/Validate 的 System Prompt（使用 ChatPromptTemplate）
// 思考阶段模板由 prompts/ 目录管理，此处仅做阶段编排
// ================================================================

/**
 * 全局 Agent 类
 * 单例，管理 LangChain 工作流的生命周期
 */
class GlobalAgent {
  private llm: ChatOpenAI | null = null;
  private initialized = false;

  /** 检测 llm 是否可用的 getter */
  get isInitialized(): boolean {
    return this.initialized && this.llm !== null;
  }

  /**
   * 初始化 Agent（从 .env 自动读取配置）
   */
  initialize(config?: GlobalAgentConfig): void {
    if (this.initialized) return;

    var apiKey = config?.apiKey || process.env.ZHIPUAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("[GlobalAgent] 未配置 API Key，Agent 无法工作。请在 .env 中设置 ZHIPUAI_API_KEY 或 DEEPSEEK_API_KEY");
      return;
    }

    // 自动推断 provider
    var provider: LLMProvider = config?.provider || "zhipu";
    if (!config?.provider) {
      if (apiKey === process.env.DEEPSEEK_API_KEY) provider = "deepseek";
      else if (apiKey === process.env.OPENAI_API_KEY) provider = "openai";
    }

    this.llm = createChatModel({
      provider,
      apiKey,
      modelName: config?.modelName,
      temperature: config?.temperature ?? 0.1,
    });

    this.initialized = true;
    console.log("[GlobalAgent] LLM 初始化完成: provider=" + provider +
                ", model=" + (config?.modelName || "default"));
  }

  /**
   * =============================================================
   * 分离式流式调用：先流式 thought → 再 JSON mode 获取结构化数据
   * =============================================================
   *
   * 原理：LLM 的思考与 JSON 输出分开两次调用
   *   第1次 llm.stream() → 纯思考过程 → yield [thought] 事件
   *   第2次 invokeWithJsonMode() → 纯 JSON → JSON.parse → 可靠的结构化数据
   *
   * @returns 第2次 JSON 调用结果对象；失败时返回 null
   */
  private async *streamPhaseWithSeparation(
    thoughtMessages: BaseMessage[],
    outputTool: StructuredTool,
    toolPrompt: string,
    toolContext: string
  ): AsyncGenerator<string, Record<string, any> | null, unknown> {
    if (!this.llm) throw new Error("LLM 未初始化");

    // 第1次：流式输出 thought
    var stream = await this.llm.stream(thoughtMessages);
    var buffer = "";
    for await (var chunk of stream) {
      var token = chunk.content.toString();
      buffer += token;
      // 按自然断点输出
      if (buffer.length >= 20 || token.includes("\n") ||
          token.includes("。") || token.includes("，") || token.includes("、")) {
        var line = buffer.trim();
        if (line) {
          yield "[thought]" + line.replace(/\n/g, " ") + "\n";
        }
        buffer = "";
      }
    }
    if (buffer.trim()) {
      yield "[thought]" + buffer.trim().replace(/\n/g, " ") + "\n";
    }

    // 第2次：tool calling 获取结构化数据
    console.log("[streamPhaseSeparation] 开始 tool calling, tool=" + outputTool.name);
    try {
      var llmWithTools = this.llm.bindTools([outputTool]);
      var response = await llmWithTools.invoke([
        new SystemMessage(toolPrompt),
        new HumanMessage(toolContext),
      ]);
      var toolCalls = response.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        var args = toolCalls[0].args;
        console.log("[streamPhaseSeparation] Tool calling 成功, keys=" + Object.keys(args).join(","));
        return args as Record<string, any>;
      }
      console.warn("[streamPhaseSeparation] Tool calling: LLM 未调用工具");
      return null;
    } catch (e: any) {
      console.warn("[streamPhaseSeparation] Tool calling 失败:", e.message?.slice(0, 200));
      return null;
    }
  }

  /**
   * =============================================================
   * Chat 模式 — 直接对话回答（无阶段流水线）
   * =============================================================
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
    yield "[tool_start]读取文档|获取文档内容\n";
    var docText = "";
    try {
      docText = await editor.getText(docId);
      yield "[tool_result]✓ 读取文档：文档全文（" + docText.length + " 字符）\n";
    } catch (e: any) {
      yield "[tool_result]✗ 读取文档：读取失败：" + (e.message || "未知错误") + "\n";
      yield "[error]无法读取文档内容，请检查文档是否正常打开\n";
      return;
    }

    // 2. 构建对话 prompt
    var chatMessages = await chatSystemPrompt.formatMessages({
      doc_name: docName,
      language_rules: LANGUAGE_RULES,
      user_input: userInput,
      doc_text: docText.substring(0, 4000) + (docText.length > 4000 ? "\n（文档较长，以上为前 4000 字符）" : ""),
    });

    // 3. 流式输出对话内容（按行 yield，保留 Markdown 格式）
    var chatStream = await this.llm!.stream(chatMessages);
    var chatBuffer = "";
    for await (var chunk of chatStream) {
      var token = chunk.content.toString();
      chatBuffer += token;
      if (token.includes("\n")) {
        var lines = chatBuffer.split("\n");
        for (var li = 0; li < lines.length - 1; li++) {
          if (lines[li].trim()) {
            yield "[chat]" + lines[li].trim() + "\n";
          }
        }
        chatBuffer = lines[lines.length - 1];
      } else if (chatBuffer.length >= 40) {
        if (chatBuffer.trim()) {
          yield "[chat]" + chatBuffer.trim() + "\n";
          chatBuffer = "";
        }
      }
    }
    if (chatBuffer.trim()) {
      yield "[chat]" + chatBuffer.trim() + "\n";
    }

    // 4. 结束
    yield "[summary]" + JSON.stringify({
      result: "success",
      summary_text: "",
      detail: "",
      failed_tasks: [],
    }) + "\n";
  }

  /**
   * =============================================================
   * 处理用户消息，SSE 流式返回
   * =============================================================
   *
   * 【流式输出策略】
   *   Analyze / Plan / Validate 阶段 → 使用 llm.stream() 逐 token 输出
   *   Execute 阶段 → 使用 ExecuteTool（内部 LLM + SDK Tools），输出执行日志
   *
   * 【SSE 事件格式】
   *   普通文本: "[分析阶段] 开始分析...\n"
   *   LLM 输出: 直接 yield LLM token
   *   事件标记: "[event:analyze_start]" (为未来的组件化渲染预留)
   * =============================================================
   */
  async *streamProcess(params: ProcessParams): AsyncGenerator<string, void, unknown> {
    if (!this.initialized || !this.llm) {
      yield "[error]Agent 未初始化，请先配置 API Key\n";
      return;
    }

    var userInput = params.message;
    var contextDocId = params.contextDocId;
    var docContext = fileRegistry.toContextString(contextDocId);
    var mode = params.mode || "workflow";

    // 确定目标文档
    var targetDocId = this.resolveTargetDocId(userInput, contextDocId);
    if (!targetDocId) {
      yield "[error]无法确定目标文档，请先上传 .docx 文件\n";
      return;
    }

    var targetName = (fileRegistry.get(targetDocId)?.originalName) || targetDocId;
    yield "[phase:start]doc_target|" + targetName + "\n";

    // ============ Chat 模式：直接对话回答 ============
    if (mode === "chat") {
      yield* this.runChatMode(targetDocId, targetName, userInput, docContext);
      return;
    }

    // ============ 内容查询自动路由 === 纯查询 → Chat 模式 ===
    var contentRE = /总结|分析|概述|介绍|是什么|讲了什么|写了什么|有哪些|概括|说明|描述|评价/i;
    var modifyRE = /替换|修改|删除|插入|加粗|改成|换成|删掉|去掉|添加|新增|追加/i;
    if (contentRE.test(userInput) && !modifyRE.test(userInput)) {
      console.log("[GlobalAgent] 检测到纯内容查询，路由到 Chat 模式");
      yield* this.runChatMode(targetDocId, targetName, userInput, docContext);
      return;
    }

    // ============ Workflow 模式：多阶段流水线 ==========
    // ===== Agent 主循环（支持重试） =====
    var retryCount = 0;
    var cachedDocText = "";  // 文本缓存，避免重复 SDK 读取

    while (retryCount < MAX_RETRY) {
      var relatedMemory = retrieveMemory(targetDocId, userInput);

      // ============================================================
      // 阶段1: Analyze — 先流式 thought → 再 tool calling 获取结构化数据
      yield "[phase]正在分析您的需求...\n";

      var analysisContext = `## 用户需求\n${userInput}\n\n## 当前可用文档\n${docContext}\n\n## 相关历史\n${relatedMemory}`;

      var analysisThoughtMsgs = await analyzeThoughtPrompt.formatMessages({
        classification_rules: CLASSIFICATION_RULES,
        anti_leak_rules: ANTI_LEAK_RULES,
        user_input: userInput,
        doc_context: docContext,
        related_memory: relatedMemory,
      });

      var analysisTool = new AnalysisOutputTool();
      var analysisGen = this.streamPhaseWithSeparation(
        analysisThoughtMsgs,
        analysisTool,
        (await analyzeToolPrompt.formatMessages({ analysis_context: analysisContext }))[0].content as string,
        analysisContext
      );
      var analysisResult = await analysisGen.next();
      while (!analysisResult.done) {
        yield analysisResult.value as string;
        analysisResult = await analysisGen.next();
      }
      var analysisObj = analysisResult.value;

      // 从 JSON 对象生成 content 摘要
      if (analysisObj && typeof analysisObj === "object") {
        var analysisSummary = this.generatePhaseSummaryFromObj("analyze", analysisObj);
        if (analysisSummary) {
          var analysisLines = analysisSummary.split("\n");
          for (var aline of analysisLines) {
            if (aline.trim()) yield "[content]" + aline.trim() + "\n";
          }
        }
        var cleanAnalysis = JSON.stringify(analysisObj);
      } else {
        console.warn("[GlobalAgent] Analyze tool calling 返回 null，使用空分析");
        var cleanAnalysis = "{}";
      }
      yield "[phase]分析完成\n";

      // ============================================================
      // 阶段2: Plan — 先流式 thought → 再 tool calling 获取结构化数据
      yield "[phase]正在制定执行计划...\n";

      var planContext = `## 分析结果\n${cleanAnalysis}\n\n## 当前可用文档\n${docContext}` +
        (cachedDocText ? `\n\n## 已有文档内容片段\n${cachedDocText.substring(0, 2000)}` : "");

      var planThoughtMsgs = await planThoughtPrompt.formatMessages({
        anti_leak_rules: ANTI_LEAK_RULES,
        clean_analysis: cleanAnalysis,
        doc_context: docContext,
        doc_snippet: cachedDocText ? cachedDocText.substring(0, 2000) : "",
      });

      var planTool = new PlanOutputTool();
      var planGen = this.streamPhaseWithSeparation(
        planThoughtMsgs,
        planTool,
        (await planToolPrompt.formatMessages({ plan_context: planContext }))[0].content as string,
        planContext
      );
      var planResult = await planGen.next();
      while (!planResult.done) {
        yield planResult.value as string;
        planResult = await planGen.next();
      }
      var planObj = planResult.value;

      if (planObj && typeof planObj === "object") {
        var planSummary = this.generatePhaseSummaryFromObj("plan", planObj);
        if (planSummary) {
          var planLines = planSummary.split("\n");
          for (var pline of planLines) {
            if (pline.trim()) yield "[content]" + pline.trim() + "\n";
          }
        }
        var cleanPlan = JSON.stringify(planObj);
      } else {
        console.warn("[GlobalAgent] Plan tool calling 返回 null，使用空计划");
        var cleanPlan = '{"tasks":[]}';
      }
      yield "[phase]计划制定完成\n";

      // ============================================================
      // 阶段3: Execute — LLM 驱动执行（调用 SDK Tools）
      // ============================================================
      yield "[phase]正在处理文档...\n";

      var executeTool = new ExecuteTool(this.llm);
      var executeResultStr = await executeTool._call({
        plan_tasks: cleanPlan,
        docId: targetDocId,
      });

      // 解析执行结果，发出结构化 tool 事件（使用自然语言显示名）
      var executionLog = executeResultStr;
      try {
        var parsedExec = JSON.parse(executeResultStr);
        executionLog = parsedExec.execution_log || executeResultStr;
        // 发出每个工具调用事件
        if (parsedExec.tool_calls && Array.isArray(parsedExec.tool_calls)) {
          for (var tc of parsedExec.tool_calls) {
            var disp = TOOL_DISPLAY[tc.tool] || { name: tc.tool, args: () => JSON.stringify(tc.args || {}) };
            var dispArgs = disp.args(tc.args || {});
            yield "[tool_start]" + disp.name + "|" + dispArgs + "\n";
            yield "[tool_result]" + (tc.status === "success" ? "✓ " : "✗ ") + disp.name + "：" + (tc.result || "完成") + "\n";
            // 缓存文档文本，避免重试时重复调用 sdk_get_text
            if (tc.tool === "sdk_get_text" && tc.status === "success" && tc.result) {
              var textMatch = tc.result.match(/：(.+)/);
              cachedDocText = textMatch ? textMatch[1] : tc.result;
            }
          }
        }
      } catch { /* keep raw */ }

      yield "[phase]文档处理完成\n";

      // ============================================================
      // 阶段4: Generate — 基于执行结果生成用户可见的回答
      // ============================================================
      yield "[phase]正在生成回答...\n";

      // 从工具调用结果中提取文档文本片段
      var docSnippet = "";
      try {
        var parsedExecForGen = JSON.parse(executeResultStr);
        if (parsedExecForGen.tool_calls && Array.isArray(parsedExecForGen.tool_calls)) {
          for (var tc2 of parsedExecForGen.tool_calls) {
            if (tc2.tool === "sdk_get_text" && tc2.result) {
              var textMatch = tc2.result.match(/：(.+)/);
              docSnippet = textMatch ? textMatch[1] : tc2.result;
              if (docSnippet.length > 4000) {
                docSnippet = docSnippet.substring(0, 4000) + "...(已截断)";
              }
              break;
            }
          }
        }
      } catch { /* 忽略提取失败 */ }

      // 使用模板构建消息
      var generateMessages = await generateSystemPrompt.formatMessages({
        language_rules: LANGUAGE_RULES,
        user_input: userInput,
        execution_summary: executionLog.split("\n").slice(0, 10).join("\n"),
        doc_snippet: docSnippet || "（无文档内容）",
      });


      // 流式输出生成内容（按行 yield，保留 Markdown 格式）
      var generateStream = await this.llm.stream(generateMessages);
      var genBuffer = "";
      for await (var genChunk of generateStream) {
        var genToken = genChunk.content.toString();
        genBuffer += genToken;
        // 按换行 yield：保留 Markdown 结构
        if (genToken.includes("\n")) {
          var lines = genBuffer.split("\n");
          for (var li = 0; li < lines.length - 1; li++) {
            if (lines[li].trim()) {
              yield "[content]" + lines[li].trim() + "\n";
            }
          }
          genBuffer = lines[lines.length - 1];
        } else if (genBuffer.length >= 40) {
          // 长文本缓冲输出
          if (genBuffer.trim()) {
            yield "[content]" + genBuffer.trim() + "\n";
            genBuffer = "";
          }
        }
      }
      // flush 剩余
      if (genBuffer.trim()) {
        yield "[content]" + genBuffer.trim() + "\n";
      }
      yield "[phase]回答生成完成\n";

      // ============================================================
      // 阶段5: Validate — 先流式 thought → 再 tool calling 获取验证结果
      yield "[phase]正在验证结果...\n";

      var validateContext = `## 执行日志\n${executionLog}\n\n## 原始任务\n${cleanPlan}`;

      var validateThoughtMsgs = await validateThoughtPrompt.formatMessages({
        anti_leak_rules: ANTI_LEAK_RULES,
        execution_log: executionLog,
        plan_tasks: cleanPlan,
      });

      var validateTool = new ValidateOutputTool();
      var validateGen = this.streamPhaseWithSeparation(
        validateThoughtMsgs,
        validateTool,
        (await validateToolPrompt.formatMessages({ validate_context: validateContext }))[0].content as string,
        validateContext
      );
      var validateResult = await validateGen.next();
      while (!validateResult.done) {
        yield validateResult.value as string;
        validateResult = await validateGen.next();
      }
      var validateObj = validateResult.value;

      if (validateObj && typeof validateObj === "object") {
        var validateSummaryText = this.generatePhaseSummaryFromObj("validate", validateObj);
        if (validateSummaryText) {
          var vlines = validateSummaryText.split("\n");
          for (var vline of vlines) {
            if (vline.trim()) yield "[content]" + vline.trim() + "\n";
          }
        }
      }
      yield "[phase]验证完成\n";

      // ============================================================
      // 解析验证结果（直接从 JSON 对象读取，无需 JSON.parse）
      // ============================================================
      var success = false;
      var retryable = true;
      var needsUserInput = false;
      var validateSummary = "";
      var failedTasks: string[] = [];

      if (validateObj && typeof validateObj === "object") {
        success = validateObj.result === "成功";
        retryable = validateObj.retryable !== false;
        needsUserInput = validateObj.needs_user_input === true;
        validateSummary = validateObj.summary || validateObj.result || "";
        failedTasks = validateObj.failed_tasks || [];
      } else {
        // JSON mode 失败时的降级判断（从执行日志推断）
        console.warn("[GlobalAgent] Validate JSON mode 返回 null，从执行日志回退判断");
        if (executionLog.includes("任务完成") || executionLog.includes("成功")) {
          success = true;
          retryable = false;
          validateSummary = "执行完成（验证日志回退）";
        } else if (executionLog.includes("失败") || executionLog.includes("错误")) {
          success = false;
          retryable = true;
          validateSummary = "执行异常（验证日志回退）";
        } else {
          // 无法判断，假定执行成功（避免误重试）
          success = true;
          retryable = false;
          validateSummary = "执行完成（默认判断）";
        }
      }

      // 提取失败步骤
      var failedSteps = this.extractFailedSteps(executionLog);

      // 保存记忆
      manageMemory(
        targetDocId, userInput, retryCount,
        success ? "成功" : "失败",
        cleanAnalysis, cleanPlan, executionLog, failedSteps
      );

      // ============================================================
      // Summary 总结 — 发出结构化总结事件
      // ============================================================
      var summary: any = {};

      if (success) {
        summary = {
          result: "success",
          summary_text: "✅ 所有任务执行完成",
          detail: validateSummary || "操作已成功执行",
          failed_tasks: [],
        };
        yield "[summary]" + JSON.stringify(summary) + "\n";
        return;
      }

      if (needsUserInput || !retryable) {
        summary = {
          result: "intervention",
          summary_text: "⚠️ 需要用户介入",
          detail: validateSummary || "请提供更多信息或确认操作",
          failed_tasks: failedTasks.length > 0 ? failedTasks : failedSteps,
        };
        yield "[summary]" + JSON.stringify(summary) + "\n";
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
        yield "[summary]" + JSON.stringify(summary) + "\n";
      } else {
        summary = {
          result: "failed",
          summary_text: "❌ 重试" + MAX_RETRY + "次仍然失败",
          detail: validateSummary || "请检查文档是否存在或提供更多信息",
          failed_tasks: failedTasks.length > 0 ? failedTasks : failedSteps,
        };
        yield "[summary]" + JSON.stringify(summary) + "\n";
      }
    }
  }

  /**
   * 从 JSON 对象生成用户友好的阶段摘要文本
   */
  private generatePhaseSummaryFromObj(phase: string, data: Record<string, any>): string {
    if (phase === "analyze") {
      var intent = data.intent || "";
      var ops = data.operations || [];
      // 内容查询意图：展示用户想了解什么
      if (intent === "content_query" || (ops.length > 0 && ops[0].type === "query")) {
        var queryGoal = ops[0]?.goal || "了解文档内容";
        return "用户想了解：" + queryGoal;
      }
      // 修改操作意图
      if (ops.length === 0) return "未识别到具体操作";
      var summary = "已识别 " + ops.length + " 个操作：";
      for (var op of ops) {
        summary += "\n  • " + (op.goal || op.type || "");
      }
      return summary;
    }

    if (phase === "plan") {
      var tasks = data.tasks || [];
      if (tasks.length === 0) return "未生成任务计划";
      var summary = "已制定 " + tasks.length + " 项任务：";
      for (var t of tasks) {
        summary += "\n  • " + (t.goal || "");
      }
      return summary;
    }

    if (phase === "validate") {
      return data.summary || data.result || "验证完成";
    }

    return "";
  }

  /**
   * 从 LLM 输出文本中提取 JSON（简化版，仅处理基本格式问题）
   */
  private extractJson(text: string): string {
    try {
      JSON.parse(text);
      return text;
    } catch {
      var cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      var match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { JSON.parse(match[0]); return match[0]; } catch { /* ignore */ }
      }
      return text;
    }
  }

  /**
   * 从执行日志中提取失败步骤
   */
  private extractFailedSteps(executionLog: string): string[] {
    var failed: string[] = [];
    var lines = executionLog.split("\n");
    for (var line of lines) {
      if (line.indexOf("[工具]") >= 0 && line.indexOf("失败") >= 0) {
        var match = line.match(/\[工具\]\s*(\w+)/);
        if (match) failed.push(match[1]);
      }
    }
    return failed;
  }

  /**
   * 确定目标文档 ID
   */
  private resolveTargetDocId(userInput: string, contextDocId?: string): string | undefined {
    var allDocs = fileRegistry.getAll();
    if (allDocs.length === 0) return undefined;
    if (allDocs.length === 1) return allDocs[0].docId;

    for (var doc of allDocs) {
      if (userInput.indexOf(doc.originalName) >= 0) return doc.docId;
      var shortName = doc.originalName.replace(/\.\w+$/, "");
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

// ===== 全局单例管理 =====

var globalAgent: GlobalAgent | null = null;

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
