/**
 * ================================================================
 * GlobalAgent — 全局 LLM Agent 单例（多 Agent 架构）
 *
 * 职责：
 *   1. LLM 实例管理（初始化、配置、重置）
 *   2. Chat 模式流式对话（文档问答）
 *   3. 状态查询（是否初始化、文档数、记忆数）
 *
 * 【与多 Agent 工作流的关系】
 * 多 Agent 工作流（workflow 模式）由 wsAgentHandler → createWorkflow(graph)
 * 独立管理。GlobalAgent 只负责 Chat 模式和提供 LLM 实例引用。
 *
 * 【生命周期】
 * 1. 启动时由 app.ts 调用 initGlobalAgent() 初始化
 * 2. 初始化时 createChatModel() 创建 LLM 实例
 * 3. 运行时各模块通过 getGlobalAgent() 获取引用
 * 4. 用户可调用 reset() 清除记忆（不清除 LLM 实例）
 * ================================================================
 */

import { ChatOpenAI } from "@langchain/openai";
import { createChatModel } from "../core/llm";
import type { LLMProvider } from "../core/llm";
import {
  sseToolStart,
  sseToolResult,
  sseError,
  sseDocTarget,
  sseSummary,
  sseChat,
} from "../core/sseEmitter";
import { chatSystemPrompt, LANGUAGE_RULES } from "../prompts";
import { clearMemories, getMemories } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import editor from "../../services/editor";

// ================================================================
// 配置类型定义
// ================================================================

/** 一次 LLM 调用最多加载的文档上下文字符数（防止 token 超限） */
const MAX_DOC_CONTEXT_CHARS = 4000;

/**
 * GlobalAgent 初始化配置（可选）
 * 前端可通过 /api/agent/init 接口传入，覆盖环境变量配置。
 */
export interface GlobalAgentConfig {
  /** LLM 厂商标识 */
  provider?: LLMProvider;
  /** API Key */
  apiKey?: string;
  /** 模型名称（不传则使用厂商默认） */
  modelName?: string;
  /** 温度参数 */
  temperature?: number;
  /** 额外模型参数 */
  modelKwargs?: Record<string, unknown>;
}

/**
 * streamProcess 方法的参数
 * 包含一次对话/编辑任务所需的全部输入
 */
export interface ProcessParams {
  /** 用户自然语言消息 */
  message: string;
  /** 上下文文档 ID（可选，用户在文档页内发起操作时传入） */
  contextDocId?: string;
  /** 模式："workflow"（多Agent协作，默认）或 "chat"（自由对话） */
  mode?: "workflow" | "chat";
}

// ================================================================
// GlobalAgent 类定义（单例模式）
//
// 整个应用中只存在一个 GlobalAgent 实例。
// 通过 getGlobalAgent() 获取，通过 initGlobalAgent() 初始化。
// ================================================================

class GlobalAgent {
  /** LLM 实例（ChatOpenAI），初始化时创建 */
  private llm: ChatOpenAI | null = null;
  /** 是否已完成初始化 */
  private initialized = false;

  /** 公开的初始化状态 getter，外部通过 agent.isInitialized 检查 */
  get isInitialized(): boolean {
    return this.initialized && this.llm !== null;
  }

  /** 获取当前 LLM 实例引用（供 workflow 创建使用） */
  get currentLlm(): ChatOpenAI | null {
    return this.llm;
  }

  /**
   * 初始化 LLM 实例
   *
   * 【API Key 优先级】
   * 1. config.apiKey（前端传入）
   * 2. config.provider 对应的环境变量
   * 3. 环境变量 DEEPSEEK_API_KEY
   * 4. 环境变量 ZHIPUAI_API_KEY
   * 5. 环境变量 OPENAI_API_KEY
   *
   * 【厂商推断逻辑】
   * 如果未指定 provider，根据环境变量匹配的 API Key 自动推断：
   * DEEPSEEK_API_KEY 匹配 → deepseek，OPENAI_API_KEY 匹配 → openai
   *
   * @param config 初始化配置（可选，不传则从环境变量读取）
   */
  initialize(config?: GlobalAgentConfig): void {
    if (this.initialized) return;

    const providerEnvKey =
      config?.provider === "zhipu"
        ? process.env.ZHIPUAI_API_KEY
        : config?.provider === "openai"
          ? process.env.OPENAI_API_KEY
          : config?.provider === "deepseek"
            ? process.env.DEEPSEEK_API_KEY
            : undefined;

    const apiKey =
      config?.apiKey ||
      providerEnvKey ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.ZHIPUAI_API_KEY ||
      process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("[GlobalAgent] 未配置 API Key");
      return;
    }

    let provider: LLMProvider = config?.provider || "deepseek";
    if (!config?.provider) {
      if (
        process.env.DEEPSEEK_API_KEY &&
        apiKey === process.env.DEEPSEEK_API_KEY
      )
        provider = "deepseek";
      else if (
        process.env.OPENAI_API_KEY &&
        apiKey === process.env.OPENAI_API_KEY
      )
        provider = "openai";
    }

    const modelName = config?.modelName;
    this.llm = createChatModel({
      provider,
      apiKey,
      modelName,
      temperature: config?.temperature ?? 0.1,
      modelKwargs: config?.modelKwargs,
    });

    this.initialized = true;
    console.log(
      "[GlobalAgent] 初始化完成: provider=" +
        provider +
        ", model=" +
        (modelName || "default")
    );
  }

  /**
   * 重新初始化 LLM 实例
   *
   * 先重置状态再重新初始化。用于用户更改 API Key 或切换模型后重新配置。
   *
   * @param config 新的初始化配置
   */
  reinitialize(config?: GlobalAgentConfig): void {
    this.llm = null;
    this.initialized = false;
    this.initialize(config);
  }

  // ============================================================
  // Chat 模式 — 文档问答流式对话
  //
  // 工作流程：
  // 1. 通过 SuperDoc 获取文档纯文本
  // 2. 构造 System Prompt（含文档内容 + 语言规则 + 用户问题）
  // 3. 流式调用 LLM 并逐 token 通过 SSE 返回
  // ============================================================

  /**
   * Chat 模式处理器（私有，由 streamProcess 调用）
   *
   * @param docId     目标文档 ID
   * @param docName   文档文件名（用于 Prompt 展示）
   * @param userInput 用户自然语言输入
   * @returns SSE 事件的异步生成器
   */
  private async *runChatMode(
    docId: string,
    docName: string,
    userInput: string
  ): AsyncGenerator<string, void, unknown> {
    // 步骤1：通过 SuperDoc SDK 获取文档纯文本
    yield sseToolStart("读取文档", "获取文档内容");
    let docText = "";
    try {
      docText = await editor.getText(docId);
      yield sseToolResult(
        true,
        "读取文档",
        `文档全文（${docText.length} 字符）`
      );
    } catch (e: any) {
      yield sseToolResult(
        false,
        "读取文档",
        `读取失败：${e.message || "未知错误"}`
      );
      yield sseError("无法读取文档内容");
      return;
    }

    // 步骤2：构造 System Prompt（文档内容截断到 4000 字符防止 token 超限）
    const chatMessages = await chatSystemPrompt.formatMessages({
      doc_name: docName,
      language_rules: LANGUAGE_RULES,
      user_input: userInput,
      doc_text: docText,
      // .substring(0, MAX_DOC_CONTEXT_CHARS) +
      //   (docText.length > MAX_DOC_CONTEXT_CHARS ? `\n（文档较长，以上为前 ${MAX_DOC_CONTEXT_CHARS} 字符）` : ""),
    });

    // 步骤3：流式调用 LLM，逐 token 返回
    const chatStream = await this.llm!.stream(chatMessages);
    for await (const chunk of chatStream) {
      yield sseChat(chunk.content.toString());
    }

    yield sseSummary({
      result: "success",
      summary_text: "",
      detail: "",
      failed_tasks: [],
    });
  }

  // ============================================================
  // 流式处理入口 — 唯一对外的处理接口
  //
  // 根据 mode 字段分流：
  // - "chat"       → Chat 模式（文档问答）
  // - 内容查询语义  → 也走 Chat 模式
  // - "workflow"   → 返回错误提示（workflow 需通过 WebSocket 使用）
  // ============================================================

  /**
   * 判断用户输入是否为纯内容查询（不需要修改文档）
   *
   * 检测策略：检查是否包含"总结/分析/概述"等查询关键词，
   * 同时确保不包含"替换/修改/删除"等编辑关键词。
   * 内容查询应走 Chat 模式，编辑请求走 Workflow 模式。
   *
   * @param userInput 用户输入文本
   * @returns 是否为纯内容查询
   */
  private isContentQuery(userInput: string): boolean {
    const CONTENT_RE =
      /总结|分析|概述|介绍|是什么|讲了什么|写了什么|有哪些|概括|说明|描述|评价/i;
    const MODIFY_RE =
      /替换|修改|删除|插入|加粗|改成|换成|删掉|去掉|添加|新增|追加/i;
    return CONTENT_RE.test(userInput) && !MODIFY_RE.test(userInput);
  }

  /**
   * 流式处理主入口
   *
   * 根据 mode 和内容语义分流到 Chat 或 Workflow 模式。
   * Workflow 模式下返回错误提示，引导用户通过 WebSocket 使用。
   *
   * 【为什么 Chat 走 SSE 而 Workflow 走 WebSocket？】
   * - Chat 模式：简单的请求-响应流式对话，SSE 足够
   * - Workflow 模式：多 Agent 协作，需要双向通信（取消、中途操作），必须用 WebSocket
   *
   * @param params 包含 message、contextDocId、mode
   * @returns SSE 事件的异步生成器
   */
  async *streamProcess(
    params: ProcessParams
  ): AsyncGenerator<string, void, unknown> {
    if (!this.initialized || !this.llm) {
      yield sseError("Agent 未初始化，请先配置 API Key");
      return;
    }

    const userInput = params.message;
    const contextDocId = params.contextDocId;
    const mode = params.mode || "workflow";

    // Chat 模式：直接对话（不修改文档）
    if (mode === "chat") {
      const targetDocId = this.resolveTargetDocId(userInput, contextDocId);
      if (!targetDocId) {
        yield sseError("无法确定目标文档");
        return;
      }
      yield sseDocTarget(
        fileRegistry.get(targetDocId)?.originalName || targetDocId
      );
      yield* this.runChatMode(
        targetDocId,
        fileRegistry.get(targetDocId)?.originalName || targetDocId,
        userInput
      );
      return;
    }

    // 内容查询语义 → 按 Chat 模式处理（不触发 workflow）
    if (this.isContentQuery(userInput)) {
      const targetDocId = this.resolveTargetDocId(userInput, contextDocId);
      if (!targetDocId) {
        yield sseError("无法确定目标文档");
        return;
      }
      yield sseDocTarget(
        fileRegistry.get(targetDocId)?.originalName || targetDocId
      );
      yield* this.runChatMode(
        targetDocId,
        fileRegistry.get(targetDocId)?.originalName || targetDocId,
        userInput
      );
      return;
    }

    // Workflow 模式 → 由 wsAgentHandler 通过 createWorkflow 处理
    yield sseError("Workflow 模式请通过 WebSocket 使用");
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /**
   * 从用户输入中解析目标文档 ID
   *
   * 【优先级策略】
   * 1. 只有一个文档 → 直接返回该文档
   * 2. 多个文档 → 从用户输入中匹配文件名（含扩展名或不含扩展名）
   * 3. 匹配失败 → 使用 contextDocId（用户在文档页内发起操作时）
   * 4. 都失败 → 返回第一个文档作为兜底
   *
   * @param userInput     用户输入文本
   * @param contextDocId  前端传入的上下文文档 ID
   * @returns 解析出的文档 ID，没有可用文档时返回 undefined
   */
  private resolveTargetDocId(
    userInput: string,
    contextDocId?: string
  ): string | undefined {
    const allDocs = fileRegistry.getAll();
    if (allDocs.length === 0) return undefined;
    if (allDocs.length === 1) return allDocs[0].docId;
    for (const doc of allDocs) {
      if (userInput.includes(doc.originalName)) return doc.docId;
      if (userInput.includes(doc.originalName.replace(/\.\w+$/, "")))
        return doc.docId;
    }
    if (contextDocId && fileRegistry.get(contextDocId)) return contextDocId;
    return allDocs[0].docId;
  }

  /**
   * 重置 Agent 记忆（不清除 LLM 实例）
   */
  async reset(): Promise<void> {
    await clearMemories();
    console.log("[GlobalAgent] 记忆已重置");
  }

  /**
   * 获取 Agent 当前状态摘要（用于前端诊断面板）
   * @returns 包含初始化状态、文档数、记忆数的状态对象
   */
  getStatus(): {
    initialized: boolean;
    docCount: number;
    memoryLength: number;
  } {
    return {
      initialized: this.initialized,
      docCount: fileRegistry.count,
      memoryLength: getMemories().length,
    };
  }
}

// ================================================================
// 单例管理 — 确保全局只有一个 GlobalAgent 实例
//
// initGlobalAgent: 由 app.ts 在启动时调用
// getGlobalAgent:  运行时代码获取 Agent 引用（懒加载）
// resetGlobalAgent: 清除记忆数据
// ================================================================

/** 全局单例变量 */
let globalAgent: GlobalAgent | null = null;

/**
 * 初始化全局 Agent
 *
 * 【调用时机】app.ts 启动时调用一次，可传入前端配置覆盖默认值
 *
 * @param config 初始化配置（可选）
 */
export async function initGlobalAgent(
  config?: GlobalAgentConfig
): Promise<void> {
  if (globalAgent) {
    console.log("[GlobalAgent] 已存在");
    return;
  }
  globalAgent = new GlobalAgent();
  globalAgent.initialize(config);
}

/**
 * 获取全局 Agent 实例（懒加载单例模式）
 *
 * 如果尚未调用 initGlobalAgent，首次调用时会创建一个空实例（未初始化），
 * 此时 isInitialized 为 false，其他模块需检查此状态。
 *
 * @returns GlobalAgent 单例
 */
export function getGlobalAgent(): GlobalAgent {
  if (!globalAgent) {
    globalAgent = new GlobalAgent();
    console.warn("[GlobalAgent] 未初始化");
  }
  return globalAgent;
}

/**
 * 重置全局 Agent（清除记忆，不清除 LLM 实例）
 */
export function resetGlobalAgent(): void {
  globalAgent?.reset();
}
