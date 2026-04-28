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
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createChatModel } from "../core/llm";
import type { LLMProvider } from "../core/llm";
import { JSONAgent } from "./jsonAgent";
import { AnalyzeTool, PlanTool, ExecuteTool, ValidateTool } from "../tools";
import { retrieveMemory, manageMemory, clearMemories, getMemories } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import editor from "../../services/editor";

/** 最大重试次数 */
const MAX_RETRY = 3;

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
// Analyze/Plan/Validate 的 System Prompt（拆分为思考版 + JSON 版）
// 思考版：只输出思考，不输出 JSON
// JSON 版：基于思考结果，用 JSON mode 输出结构化数据
// ================================================================

// --- Analyze ---
const ANALYZE_THOUGHT_PROMPT = `你是一个文档处理需求的**分析专家**。
根据用户的自然语言需求和可用文档信息，分析用户的操作意图。
输出你的思考过程（只需思考，**不要输出 JSON**）。`;

const ANALYZE_JSON_PROMPT = `你是一个文档处理需求的**分析专家**。
基于以上分析，输出 JSON 格式的分析结果。
只输出 JSON 对象，不要加任何额外文字。`;

// --- Plan ---
const PLAN_THOUGHT_PROMPT = `你是一个文档处理任务的**规划专家**。
根据分析结果，制定语义化的任务清单。输出你的思考过程（只需思考，**不要输出 JSON**）。`;

const PLAN_JSON_PROMPT = `你是一个文档处理任务的**规划专家**。
基于以上分析，输出 JSON 格式的任务计划。
只输出 JSON 对象，不要加任何额外文字。`;

// --- Validate ---
const VALIDATE_THOUGHT_PROMPT = `你是一个文档操作结果的**验证专家**。
根据执行日志判断操作是否成功。输出你的思考过程（只需思考，**不要输出 JSON**）。`;

const VALIDATE_JSON_PROMPT = `你是一个文档操作结果的**验证专家**。
基于以上分析，输出 JSON 格式的验证结果。
只输出 JSON 对象，不要加任何额外文字。`;

// 旧 prompt 保留（不再直接使用，仅作参考）

/**
 * 全局 Agent 类
 * 单例，管理 LangChain 工作流的生命周期
 */
class GlobalAgent {
  private llm: ChatOpenAI | null = null;
  private jsonAgent: JSONAgent | null = null;
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
    this.jsonAgent = new JSONAgent(provider, apiKey, config?.modelName);
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
    thoughtMessages: (SystemMessage | HumanMessage)[],
    jsonMessages: (SystemMessage | HumanMessage)[]
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

    // 第2次：JSON mode 获取结构化数据
    if (!this.jsonAgent) {
      console.warn("[streamPhaseSeparation] jsonAgent 未初始化");
      return null;
    }
    console.log("[streamPhaseSeparation] 开始 JSON mode 调用");
    var jsonObj = await this.jsonAgent.call(
      String(jsonMessages[0]?.content || ""),
      String(jsonMessages[1]?.content || "")
    );
    if (jsonObj) {
      console.log("[streamPhaseSeparation] JSON mode 成功, keys=" + Object.keys(jsonObj).join(","));
    } else {
      console.warn("[streamPhaseSeparation] JSON mode 返回 null");
    }

    return jsonObj;
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
    yield "[tool_start]sdk_get_text|获取文档内容\n";
    var docText = "";
    try {
      docText = await editor.getText(docId);
      yield "[tool]sdk_get_text|获取文档内容\n";
      yield "[tool_result]✓ 文档全文（" + docText.length + " 字符）\n";
    } catch (e: any) {
      yield "[tool]sdk_get_text|获取文档内容\n";
      yield "[tool_result]✗ 读取失败：" + (e.message || "未知错误") + "\n";
      yield "[error]无法读取文档内容，请检查文档是否正常打开\n";
      return;
    }

    // 2. 构建对话 prompt（强化 Markdown 输出）
    var chatMessages = [
      new SystemMessage(
        `你是文档处理助手。用户正在查看文档"${docName}"。\n` +
        `请根据文档内容和用户问题，提供结构清晰的回答。\n\n` +
        `**必须使用 Markdown 格式**，包括：\n` +
        `- 使用 ## 标题分隔段落\n` +
        `- 使用 - 或 1. 创建列表\n` +
        `- 使用 **加粗** 突出关键词\n` +
        `- 如果文档内容较多，只提取与问题相关的部分\n\n` +
        `禁止事项：\n` +
        `- 不要输出 JSON 格式数据`
      ),
      new HumanMessage(
        `## 用户问题\n${userInput}\n\n` +
        `## 文档内容\n${docText.substring(0, 4000)}` +
        (docText.length > 4000 ? "\n（文档较长，以上为前 4000 字符）" : "")
      ),
    ];

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

    // ============ Workflow 模式：4 阶段流水线 ==========
    // ===== Agent 主循环（支持重试） =====
    var retryCount = 0;
    var cachedDocText = "";  // 文本缓存，避免重复 SDK 读取

    while (retryCount < MAX_RETRY) {
      var relatedMemory = retrieveMemory(targetDocId, userInput);

      // ============================================================
      // 阶段1: Analyze — 先流式 thought → 再 JSON mode 获取结构化数据
      yield "[phase:analyze]\n";

      var analysisContext = `## 用户需求\n${userInput}\n\n## 当前可用文档\n${docContext}\n\n## 相关历史\n${relatedMemory}`;

      var analysisThoughtMsgs = [
        new SystemMessage(ANALYZE_THOUGHT_PROMPT),
        new HumanMessage(analysisContext),
      ];
      var analysisJsonMsgs = [
        new SystemMessage(ANALYZE_JSON_PROMPT),
        new HumanMessage(`基于以上分析，输出 JSON 格式的分析结果。\n\n原始上下文：\n${analysisContext}`),
      ];

      var analysisGen = this.streamPhaseWithSeparation(analysisThoughtMsgs, analysisJsonMsgs);
      for await (var analysisYield of analysisGen) {
        yield analysisYield;
      }
      var analysisObj = (await analysisGen.next()).value;

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
        console.warn("[GlobalAgent] Analyze JSON mode 返回 null，使用空分析");
        var cleanAnalysis = "{}";
      }
      yield "[phase:analyze:end]\n";

      // ============================================================
      // 阶段2: Plan — 先流式 thought → 再 JSON mode 获取结构化数据
      yield "[phase:plan]\n";

      var planContext = `## 分析结果\n${cleanAnalysis}\n\n## 当前可用文档\n${docContext}` +
        (cachedDocText ? `\n\n## 已有文档内容片段\n${cachedDocText.substring(0, 2000)}` : "");

      var planThoughtMsgs = [
        new SystemMessage(PLAN_THOUGHT_PROMPT),
        new HumanMessage(planContext),
      ];
      var planJsonMsgs = [
        new SystemMessage(PLAN_JSON_PROMPT),
        new HumanMessage(`基于以上分析，输出 JSON 格式的任务计划。\n\n原始上下文：\n${planContext}`),
      ];

      var planGen = this.streamPhaseWithSeparation(planThoughtMsgs, planJsonMsgs);
      for await (var planYield of planGen) {
        yield planYield;
      }
      var planObj = (await planGen.next()).value;

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
        console.warn("[GlobalAgent] Plan JSON mode 返回 null，使用空计划");
        var cleanPlan = '{"tasks":[]}';
      }
      yield "[phase:plan:end]\n";

      // ============================================================
      // 阶段3: Execute — LLM 驱动执行（调用 SDK Tools）
      // ============================================================
      yield "[phase:execute]\n";

      var executeTool = new ExecuteTool(this.llm);
      var executeResultStr = await executeTool._call({
        plan_tasks: cleanPlan,
        docId: targetDocId,
      });

      // 解析执行结果，发出结构化 tool 事件
      var executionLog = executeResultStr;
      try {
        var parsedExec = JSON.parse(executeResultStr);
        executionLog = parsedExec.execution_log || executeResultStr;
        // 发出每个工具调用事件
        if (parsedExec.tool_calls && Array.isArray(parsedExec.tool_calls)) {
          for (var tc of parsedExec.tool_calls) {
            yield "[tool_start]" + tc.tool + "|" + (tc.args || "{}") + "\n";
            yield "[tool]" + tc.tool + "|" + (tc.args || "{}") + "\n";
            yield "[tool_result]" + (tc.status === "success" ? "✓ " : "✗ ") + (tc.result || "") + "\n";
            // 缓存文档文本，避免重试时重复调用 sdk_get_text
            if (tc.tool === "sdk_get_text" && tc.status === "success" && tc.result) {
              var textMatch = tc.result.match(/：(.+)/);
              cachedDocText = textMatch ? textMatch[1] : tc.result;
            }
          }
        }
      } catch { /* keep raw */ }

      yield "[phase:execute:end]\n";

      // ============================================================
      // 阶段4: Generate — 基于执行结果生成用户可见的回答
      // ============================================================
      yield "[phase:generate]\n";

      // 从工具调用结果中提取文档文本片段
      var docSnippet = "";
      try {
        var parsedExecForGen = JSON.parse(executeResultStr);
        if (parsedExecForGen.tool_calls && Array.isArray(parsedExecForGen.tool_calls)) {
          for (var tc2 of parsedExecForGen.tool_calls) {
            if (tc2.tool === "sdk_get_text" && tc2.result) {
              // 提取 sdk_get_text 的结果文本（格式："文档全文（N 字符）：..."）
              var textMatch = tc2.result.match(/：(.+)/);
              docSnippet = textMatch ? textMatch[1] : tc2.result;
              // 截取前 4000 字符避免 context 溢出
              if (docSnippet.length > 4000) {
                docSnippet = docSnippet.substring(0, 4000) + "...(已截断)";
              }
              break;
            }
          }
        }
      } catch { /* 忽略提取失败 */ }

      // 构建生成 prompt（强化 Markdown 输出要求）
      var generateMessages = [
        new SystemMessage(
          `你是文档处理助手。根据用户需求，基于文档内容生成**详细全面的回答**。\n\n` +
          `**必须使用 Markdown 格式**，包括：\n` +
          `- 使用 ## 标题分隔段落（概述、核心内容、关键发现、总结等）\n` +
          `- 使用 - 或 1. 创建列表，尽可能列出文档中的具体信息\n` +
          `- 使用 **加粗** 突出关键词和人名、项目名\n` +
          `- 对于总结类请求，至少输出 3 个章节，每个章节列出 2-5 个要点\n` +
          `- 引用文档中的具体数据、名称、日期\n\n` +
          `禁止事项：\n` +
          `- 不要输出 JSON 格式数据\n` +
          `- 不要说"文档内容为空"或"无法总结"——文档内容已在下方提供\n` +
          `- 不要过于简略，要充分利用提供的文档内容\n\n` +
          `示例输出格式：\n` +
          `## 概述\n文档是一份关于...的申报材料，由...学院申报...\n\n` +
          `## 核心内容\n- 项目名称：**xxx**\n- 负责人：**xxx**\n- 申报日期：...\n\n` +
          `## 关键发现\n1. 该文档包含...\n2. 值得注意的是...\n\n## 总结\n综上所述，...`
        ),
        new HumanMessage(
          `## 用户需求\n${userInput}\n\n` +
          `## 执行结果摘要\n${executionLog.split("\n").slice(0, 10).join("\n")}\n\n` +
          `## 文档内容片段\n${docSnippet || "（无文档内容）"}`
        ),
      ];

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
      yield "[phase:generate:end]\n";

      // ============================================================
      // 阶段5: Validate — 先流式 thought → 再 JSON mode 获取验证结果
      yield "[phase:validate]\n";

      var validateContext = `## 执行日志\n${executionLog}\n\n## 原始任务\n${cleanPlan}`;

      var validateThoughtMsgs = [
        new SystemMessage(VALIDATE_THOUGHT_PROMPT),
        new HumanMessage(validateContext),
      ];
      var validateJsonMsgs = [
        new SystemMessage(VALIDATE_JSON_PROMPT),
        new HumanMessage(`基于以上分析，输出 JSON 格式的验证结果。\n\n原始上下文：\n${validateContext}`),
      ];

      var validateGen = this.streamPhaseWithSeparation(validateThoughtMsgs, validateJsonMsgs);
      for await (var validateYield of validateGen) {
        yield validateYield;
      }
      var validateObj = (await validateGen.next()).value;

      if (validateObj && typeof validateObj === "object") {
        var validateSummaryText = this.generatePhaseSummaryFromObj("validate", validateObj);
        if (validateSummaryText) {
          var vlines = validateSummaryText.split("\n");
          for (var vline of vlines) {
            if (vline.trim()) yield "[content]" + vline.trim() + "\n";
          }
        }
      }
      yield "[phase:validate:end]\n";

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
      var ops = data.operations || [];
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
