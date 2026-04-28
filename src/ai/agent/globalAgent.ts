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
import { AnalyzeTool, PlanTool, ExecuteTool, ValidateTool } from "../tools";
import { retrieveMemory, manageMemory, clearMemories, getMemories } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import editor from "../../services/editor";

/** 最大重试次数 */
const MAX_RETRY = 3;

/** 初始化配置 */
export interface GlobalAgentConfig {
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
// Analyze/Plan/Validate 阶段的 System Prompt
// 这些 Tool 虽然定义了完整的 _call 方法，
// 但在流式场景下，我们直接使用 LLM stream + 同样的 prompt
// ================================================================

const ANALYZE_PROMPT = `你是一个文档处理需求的**分析专家**。
你的任务是根据用户的自然语言需求，提炼出结构化的操作意图。
只分析"用户想要什么"，不涉及具体如何操作。

请先输出你的思考过程，然后输出以下 JSON 格式的分析结果（不要加 \`\`\` 标记）：

{
  "intent": "text_replace | format_change | mixed | other",
  "operations": [
    {
      "type": "replace | format | insert | delete | save",
      "target": "操作目标描述",
      "goal": "用户想要达成的效果",
      "details": "补充说明"
    }
  ],
  "context_hints": ["对当前需求的语境说明"]
}`;

const PLAN_PROMPT = `你是一个文档处理任务的**规划专家**。
根据分析结果，制定语义化的任务清单。只规划"要做什么"，不规定"怎么做"。

每个任务应该包含：
- goal: 一句话目标
- description: 详细描述
- constraints: 约束条件
- success_criteria: 成功标准

请先输出你的思考过程，然后输出以下 JSON 格式的计划（不要加 \`\`\` 标记）：

{
  "tasks": [
    {
      "id": "task-1",
      "goal": "任务目标",
      "description": "详细描述",
      "constraints": ["约束条件"],
      "success_criteria": "成功标准",
      "priority": "high"
    }
  ],
  "dependencies": [],
  "ordering": "sequential",
  "fallback_strategies": [
    { "condition": "什么情况下触发", "action": "备选方案" }
  ]
}`;

const VALIDATE_PROMPT = `你是一个文档操作结果的**验证专家**。
根据执行日志判断操作是否成功，以及是否可重试。

输出以下 JSON 格式（不要加 \`\`\` 标记）：

{
  "result": "成功|失败|部分成功",
  "summary": "简要总结",
  "retryable": true/false,
  "needs_user_input": true/false,
  "failed_tasks": ["失败任务"],
  "error_analysis": "失败原因"
}`;

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
   * 初始化 Agent
   * 创建 ChatOpenAI 实例（通过 baseURL 切换厂商）
   */
  initialize(config?: GlobalAgentConfig): void {
    if (this.initialized) {
      console.log("[GlobalAgent] 已经初始化，跳过");
      return;
    }

    var apiKey = config?.apiKey || process.env.ZHIPUAI_API_KEY;
    if (!apiKey) {
      console.warn("[GlobalAgent] 未配置 API Key，Agent 无法工作");
      return;
    }

    this.llm = createChatModel({
      provider: "zhipu",
      apiKey: apiKey,
      modelName: config?.modelName || "glm-4-flash",
      temperature: config?.temperature ?? 0.1,
    });

    this.initialized = true;
    console.log("[GlobalAgent] 初始化完成 (ChatOpenAI + LangChain)");
  }

  /**
   * =============================================================
   * 流式调用 LLM，实时 yield thought（过滤 JSON，降低缓冲阈值）
   * =============================================================
   *
   * 特性：
   *   1. 逐字符状态机：检测到 JSON 起始 `{` 时停止 thought 输出
   *   2. 低缓冲阈值（~8 字符），提高实时性
   *   3. 返回完整输出文本，供后续 extractJson 处理
   */
  private async *streamLLMWithThoughtFilter(
    messages: (SystemMessage | HumanMessage)[]
  ): AsyncGenerator<string, string, unknown> {
    if (!this.llm) throw new Error("LLM 未初始化");

    var fullOutput = "";
    var stream = await this.llm.stream(messages);
    var thoughtBuffer = "";
    var jsonDepth = 0;
    var inJson = false;

    for await (var chunk of stream) {
      var token = chunk.content.toString();
      fullOutput += token;

      for (var i = 0; i < token.length; i++) {
        var char = token[i];

        if (char === '{' && !inJson) {
          // 进入 JSON，先 flush thought buffer
          if (thoughtBuffer.trim()) {
            yield "[thought]" + thoughtBuffer.trim().replace(/\n/g, " ") + "\n";
            thoughtBuffer = "";
          }
          inJson = true;
          jsonDepth = 1;
        } else if (char === '{' && inJson) {
          jsonDepth++;
        } else if (char === '}' && inJson) {
          jsonDepth--;
          if (jsonDepth === 0) {
            inJson = false;
          }
        } else if (!inJson) {
          thoughtBuffer += char;
          // 小缓冲输出：每 ~8 字符或遇到自然断点
          if (thoughtBuffer.length >= 8 || char === '\n' || char === '。' || char === '，') {
            var line = thoughtBuffer.replace(/\n/g, " ").trim();
            if (line) {
              yield "[thought]" + line + "\n";
            }
            thoughtBuffer = "";
          }
        }
        // inJson === true 时：处于 JSON 内部，不输出任何内容
      }
    }

    // flush 剩余 thought
    if (thoughtBuffer.trim()) {
      yield "[thought]" + thoughtBuffer.trim().replace(/\n/g, " ") + "\n";
    }

    return fullOutput;
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

    // 2. 构建对话 prompt
    var chatMessages = [
      new SystemMessage(
        `你是一个文档处理助手。用户正在查看文档"${docName}"。\n` +
        `请根据文档内容和用户问题，提供有帮助的回答。\n` +
        `- 使用 Markdown 格式化回答\n` +
        `- 如果文档内容较多，只提取与问题相关的部分\n` +
        `- 保持回答简洁清晰\n` +
        `- 不要输出 JSON 格式数据`
      ),
      new HumanMessage(
        `## 用户问题\n${userInput}\n\n` +
        `## 文档内容\n${docText.substring(0, 4000)}` +
        (docText.length > 4000 ? "\n（文档较长，以上为前 4000 字符）" : "")
      ),
    ];

    // 3. 流式输出对话内容（使用 [chat] 事件）
    var chatStream = await this.llm!.stream(chatMessages);
    var chatBuffer = "";
    for await (var chunk of chatStream) {
      var token = chunk.content.toString();
      chatBuffer += token;
      if (chatBuffer.length >= 10 || token.includes("\n")) {
        yield "[chat]" + chatBuffer.replace(/\n/g, " ").trim() + "\n";
        chatBuffer = "";
      }
    }
    if (chatBuffer.trim()) {
      yield "[chat]" + chatBuffer.replace(/\n/g, " ").trim() + "\n";
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
      // 阶段1: Analyze — LLM 流式分析需求（过滤 JSON，实时 yield thought）
      yield "[phase:analyze]\n";

      var analysisMessages = [
        new SystemMessage(ANALYZE_PROMPT),
        new HumanMessage(
          `## 用户需求\n${userInput}\n\n## 当前可用文档\n${docContext}\n\n## 相关历史\n${relatedMemory}`
        ),
      ];

      // 使用过滤方法：自动过滤 JSON，逐字符实时输出 thought
      var analysisGen = this.streamLLMWithThoughtFilter(analysisMessages);
      for await (var analysisYield of analysisGen) {
        yield analysisYield;
      }
      var analysisFullOutput = (await analysisGen.next()).value || "";

      // 提取 JSON 并生成 content 摘要
      var cleanAnalysis = this.extractJson(analysisFullOutput);
      var analysisSummary = this.generatePhaseSummary("analyze", cleanAnalysis);
      if (analysisSummary) {
        var analysisLines = analysisSummary.split("\n");
        for (var aline of analysisLines) {
          if (aline.trim()) yield "[content]" + aline.trim() + "\n";
        }
      }
      yield "[phase:analyze:end]\n";

      // ============================================================
      // 阶段2: Plan — LLM 流式制定任务清单（过滤 JSON，实时 yield thought）
      yield "[phase:plan]\n";

      var planMessages = [
        new SystemMessage(PLAN_PROMPT),
        new HumanMessage(
          `## 分析结果\n${cleanAnalysis}\n\n## 当前可用文档\n${docContext}` +
          (cachedDocText ? `\n\n## 已有文档内容片段\n${cachedDocText.substring(0, 2000)}` : "")
        ),
      ];

      var planGen = this.streamLLMWithThoughtFilter(planMessages);
      for await (var planYield of planGen) {
        yield planYield;
      }
      var planFullOutput = (await planGen.next()).value || "";

      var cleanPlan = this.extractJson(planFullOutput);
      var planSummary = this.generatePhaseSummary("plan", cleanPlan);
      if (planSummary) {
        var planLines = planSummary.split("\n");
        for (var pline of planLines) {
          if (pline.trim()) yield "[content]" + pline.trim() + "\n";
        }
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

      // 构建生成 prompt
      var generateMessages = [
        new SystemMessage(
          `你是一个文档处理助手。根据用户需求和文档内容，生成简洁、有帮助的回答。\n` +
          `- 如果用户请求总结或查看内容，直接输出内容的概述和关键点\n` +
          `- 如果用户请求修改文档，简要说明已完成的操作\n` +
          `- 不要输出 JSON 格式数据\n` +
          `- 使用 Markdown 格式化回答（列表、加粗等）`
        ),
        new HumanMessage(
          `## 用户需求\n${userInput}\n\n` +
          `## 执行结果摘要\n${executionLog.split("\n").slice(0, 10).join("\n")}\n\n` +
          `## 文档内容片段\n${docSnippet || "（无文档内容）"}`
        ),
      ];

      // 流式输出生成内容（逐 token，不显示为 thought）
      var generateStream = await this.llm.stream(generateMessages);
      var genBuffer = "";
      for await (var genChunk of generateStream) {
        var genToken = genChunk.content.toString();
        genBuffer += genToken;
        // 小缓冲输出，实时到达前端
        if (genBuffer.length >= 10 || genToken.includes("\n")) {
          yield "[content]" + genBuffer.replace(/\n/g, " ").trim() + "\n";
          genBuffer = "";
        }
      }
      if (genBuffer.trim()) {
        yield "[content]" + genBuffer.replace(/\n/g, " ").trim() + "\n";
      }
      yield "[phase:generate:end]\n";

      // ============================================================
      // 阶段5: Validate — LLM 流式验证结果（过滤 JSON，实时 yield thought）
      yield "[phase:validate]\n";

      var validateMessages = [
        new SystemMessage(VALIDATE_PROMPT),
        new HumanMessage(
          `## 执行日志\n${executionLog}\n\n## 原始任务\n${planFullOutput}`
        ),
      ];

      var validateGen = this.streamLLMWithThoughtFilter(validateMessages);
      for await (var validateYield of validateGen) {
        yield validateYield;
      }
      var validateFullOutput = (await validateGen.next()).value || "";

      var cleanValidate = this.extractJson(validateFullOutput);
      var validateSummaryText = this.generatePhaseSummary("validate", cleanValidate);
      if (validateSummaryText) {
        var vlines = validateSummaryText.split("\n");
        for (var vline of vlines) {
          if (vline.trim()) yield "[content]" + vline.trim() + "\n";
        }
      }
      yield "[phase:validate:end]\n";

      // ============================================================
      // 解析验证结果
      // ============================================================
      var success = false;
      var retryable = true;
      var needsUserInput = false;
      var validateSummary = "";
      var failedTasks: string[] = [];

      try {
        var parsed = JSON.parse(cleanValidate);
        success = parsed.result === "成功";
        retryable = parsed.retryable !== false;
        needsUserInput = parsed.needs_user_input === true;
        validateSummary = parsed.summary || parsed.result || "";
        failedTasks = parsed.failed_tasks || [];
      } catch { /* 使用默认值 */ }

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
   * 从阶段结果的 JSON 生成用户友好的摘要文本
   * 不展示原始 JSON，只展示可读的总结
   */
  private generatePhaseSummary(phase: string, jsonStr: string): string {
    try {
      var data = JSON.parse(jsonStr);

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
    } catch {
      return "";
    }
  }

  /**
   * 确定目标文档 ID
   * 逻辑与旧版一致：按文档名匹配 → contextDocId → 默认第一个
   */
  private resolveTargetDocId(userInput: string, contextDocId?: string): string | undefined {
    var allDocs = fileRegistry.getAll();
    if (allDocs.length === 0) return undefined;
    if (allDocs.length === 1) return allDocs[0].docId;

    // 1. 用户消息中明确提到文档名
    for (var doc of allDocs) {
      if (userInput.indexOf(doc.originalName) >= 0) return doc.docId;
      var shortName = doc.originalName.replace(/\.\w+$/, "");
      if (userInput.indexOf(shortName) >= 0) return doc.docId;
    }

    // 2. 使用 contextDocId
    if (contextDocId && fileRegistry.get(contextDocId)) return contextDocId;

    // 3. 默认第一个
    return allDocs[0].docId;
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
   * 从 LLM 输出文本中提取第一个完整 JSON 对象
   *
   * LLM 经常在 JSON 外面包裹 markdown 代码块和思考过程：
   *   思考过程...
   *   ```json
   *   { "tasks": [...] }
   *   ```
   * 这个函数用大括号匹配提取出纯净的 JSON 字符串。
   *
   * @param text - LLM 原始输出（可能包含思考过程 + markdown）
   * @returns 纯 JSON 字符串；如果没找到 JSON 则返回原文本
   */
  private extractJson(text: string): string {
    var stack: string[] = [];
    var start = -1;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === "{") {
        if (stack.length === 0) start = i;
        stack.push("{");
      } else if (text[i] === "}") {
        stack.pop();
        if (stack.length === 0 && start >= 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return text;
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
