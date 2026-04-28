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

    // 确定目标文档
    var targetDocId = this.resolveTargetDocId(userInput, contextDocId);
    if (!targetDocId) {
      yield "[error]无法确定目标文档，请先上传 .docx 文件\n";
      return;
    }

    var targetName = (fileRegistry.get(targetDocId)?.originalName) || targetDocId;
    yield "[phase:start]doc_target|" + targetName + "\n";

    // ===== Agent 主循环（支持重试） =====
    var retryCount = 0;

    while (retryCount < MAX_RETRY) {
      var relatedMemory = retrieveMemory(targetDocId, userInput);

      // ============================================================
      // 阶段1: Analyze — LLM 流式分析需求
      // ============================================================
      yield "[phase:analyze]\n";

      var analysisMessages = [
        new SystemMessage(ANALYZE_PROMPT),
        new HumanMessage(
          `## 用户需求\n${userInput}\n\n## 当前可用文档\n${docContext}\n\n## 相关历史\n${relatedMemory}`
        ),
      ];

      // 收集完整 LLM 输出
      var analysisFullOutput = "";
      var analysisStream = await this.llm.stream(analysisMessages);
      for await (var chunk of analysisStream) {
        var token = chunk.content.toString();
        analysisFullOutput += token;
      }
      // 提取 JSON 和 thought
      var cleanAnalysis = this.extractJson(analysisFullOutput);
      yield this.buildPhaseContent("analyze", analysisFullOutput, cleanAnalysis);
      yield "[phase:analyze:end]\n";

      // ============================================================
      // 阶段2: Plan — LLM 流式制定任务清单
      // ============================================================
      yield "[phase:plan]\n";

      var planMessages = [
        new SystemMessage(PLAN_PROMPT),
        new HumanMessage(
          `## 分析结果\n${cleanAnalysis}\n\n## 当前可用文档\n${docContext}`
        ),
      ];

      var planFullOutput = "";
      var planStream = await this.llm.stream(planMessages);
      for await (var chunk of planStream) {
        var token = chunk.content.toString();
        planFullOutput += token;
      }
      var cleanPlan = this.extractJson(planFullOutput);
      yield this.buildPhaseContent("plan", planFullOutput, cleanPlan);
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
            yield "[tool]" + tc.tool + "|" + (tc.args || "{}") + "\n";
            yield "[tool_result]" + (tc.status === "success" ? "✓ " : "✗ ") + (tc.result || "") + "\n";
          }
        }
      } catch { /* keep raw */ }

      yield "[phase:execute:end]\n";

      // ============================================================
      // 阶段4: Validate — LLM 流式验证结果
      // ============================================================
      yield "[phase:validate]\n";

      var validateMessages = [
        new SystemMessage(VALIDATE_PROMPT),
        new HumanMessage(
          `## 执行日志\n${executionLog}\n\n## 原始任务\n${planFullOutput}`
        ),
      ];

      var validateFullOutput = "";
      var validateStream = await this.llm.stream(validateMessages);
      for await (var chunk of validateStream) {
        var token = chunk.content.toString();
        validateFullOutput += token;
      }
      var cleanValidate = this.extractJson(validateFullOutput);
      yield this.buildPhaseContent("validate", validateFullOutput, cleanValidate);
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
   * 从 LLM 原始输出中拆分 thought（思考过程）和 content（用户可见摘要），
   * 生成结构化的阶段内容事件。
   *
   * 【事件输出】
   *   [thought]思考过程行1     ← 可折叠
   *   [thought]思考过程行2
   *   [content]用户可见摘要    ← 展示在阶段面板中
   */
  private buildPhaseContent(phase: string, fullOutput: string, cleanJson: string): string {
    var result = "";

    // 从完整输出中提取 thought：cleanJson 之前的所有内容
    var jsonIndex = fullOutput.indexOf(cleanJson);
    var thoughtText = jsonIndex >= 0
      ? fullOutput.substring(0, jsonIndex).trim()
      : "";

    // 发出 thought 事件（每行一个）
    if (thoughtText) {
      var thoughtLines = thoughtText.split("\n");
      for (var line of thoughtLines) {
        var trimmed = line.trim();
        if (trimmed) {
          result += "[thought]" + trimmed + "\n";
        }
      }
    }

    // 从 JSON 生成用户友好的摘要内容
    var summary = this.generatePhaseSummary(phase, cleanJson);
    if (summary) {
      var contentLines = summary.split("\n");
      for (var line of contentLines) {
        if (line.trim()) {
          result += "[content]" + line.trim() + "\n";
        }
      }
    }

    return result;
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
