/**
 * ================================================================
 * GlobalAgent — 全局 LLM Agent（多 Agent 架构）
 *
 * 职责：
 *   1. LLM 实例管理（初始化、配置、重置）
 *   2. Chat 模式（文档问答）
 *   3. 状态查询
 *
 * 多 Agent 工作流由 wsAgentHandler → createWorkflow(graph) 独立管理。
 * ================================================================
 */

import { ChatOpenAI } from "@langchain/openai";
import { createChatModel } from "../core/llm";
import type { LLMProvider } from "../core/llm";
import { sseToolStart, sseToolResult, sseError, sseDocTarget, sseSummary, sseChat } from "../core/sseEmitter";
import { chatSystemPrompt, LANGUAGE_RULES } from "../prompts";
import { clearMemories, getMemories } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";
import editor from "../../services/editor";

// ================================================================
// 配置
// ================================================================

const MAX_DOC_CONTEXT_CHARS = 4000;

export interface GlobalAgentConfig {
  provider?: LLMProvider;
  apiKey?: string;
  modelName?: string;
  temperature?: number;
  modelKwargs?: Record<string, unknown>;
}

export interface ProcessParams {
  message: string;
  contextDocId?: string;
  mode?: "workflow" | "chat";
}

// ================================================================
// 类定义
// ================================================================

class GlobalAgent {
  private llm: ChatOpenAI | null = null;
  private initialized = false;

  get isInitialized(): boolean {
    return this.initialized && this.llm !== null;
  }

  get currentLlm(): ChatOpenAI | null {
    return this.llm;
  }

  initialize(config?: GlobalAgentConfig): void {
    if (this.initialized) return;

    const apiKey = config?.apiKey || process.env.ZHIPUAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("[GlobalAgent] 未配置 API Key");
      return;
    }

    let provider: LLMProvider = config?.provider || "zhipu";
    if (!config?.provider) {
      if (process.env.DEEPSEEK_API_KEY && apiKey === process.env.DEEPSEEK_API_KEY) provider = "deepseek";
      else if (process.env.OPENAI_API_KEY && apiKey === process.env.OPENAI_API_KEY) provider = "openai";
    }

    const modelName = config?.modelName;
    this.llm = createChatModel({
      provider, apiKey, modelName,
      temperature: config?.temperature ?? 0.1,
      modelKwargs: config?.modelKwargs,
    });

    this.initialized = true;
    console.log("[GlobalAgent] 初始化完成: provider=" + provider + ", model=" + (modelName || "default"));
  }

  reinitialize(config?: GlobalAgentConfig): void {
    this.llm = null; this.initialized = false;
    this.initialize(config);
  }

  // ============================================================
  // Chat 模式（文档问答）
  // ============================================================

  private async *runChatMode(
    docId: string, docName: string, userInput: string,
  ): AsyncGenerator<string, void, unknown> {
    yield sseToolStart("读取文档", "获取文档内容");
    let docText = "";
    try {
      docText = await editor.getText(docId);
      yield sseToolResult(true, "读取文档", `文档全文（${docText.length} 字符）`);
    } catch (e: any) {
      yield sseToolResult(false, "读取文档", `读取失败：${e.message || "未知错误"}`);
      yield sseError("无法读取文档内容");
      return;
    }

    const chatMessages = await chatSystemPrompt.formatMessages({
      doc_name: docName,
      language_rules: LANGUAGE_RULES,
      user_input: userInput,
      doc_text: docText.substring(0, MAX_DOC_CONTEXT_CHARS) +
        (docText.length > MAX_DOC_CONTEXT_CHARS ? `\n（文档较长，以上为前 ${MAX_DOC_CONTEXT_CHARS} 字符）` : ""),
    });

    const chatStream = await this.llm!.stream(chatMessages);
    for await (const chunk of chatStream) {
      yield sseChat(chunk.content.toString());
    }

    yield sseSummary({ result: "success", summary_text: "", detail: "", failed_tasks: [] });
  }

  // ============================================================
  // 流式处理入口
  // ============================================================

  private isContentQuery(userInput: string): boolean {
    const CONTENT_RE = /总结|分析|概述|介绍|是什么|讲了什么|写了什么|有哪些|概括|说明|描述|评价/i;
    const MODIFY_RE = /替换|修改|删除|插入|加粗|改成|换成|删掉|去掉|添加|新增|追加/i;
    return CONTENT_RE.test(userInput) && !MODIFY_RE.test(userInput);
  }

  async *streamProcess(params: ProcessParams): AsyncGenerator<string, void, unknown> {
    if (!this.initialized || !this.llm) {
      yield sseError("Agent 未初始化，请先配置 API Key");
      return;
    }

    const userInput = params.message;
    const contextDocId = params.contextDocId;
    const mode = params.mode || "workflow";

    // Chat 模式
    if (mode === "chat") {
      const targetDocId = this.resolveTargetDocId(userInput, contextDocId);
      if (!targetDocId) { yield sseError("无法确定目标文档"); return; }
      yield sseDocTarget(fileRegistry.get(targetDocId)?.originalName || targetDocId);
      yield* this.runChatMode(targetDocId, fileRegistry.get(targetDocId)?.originalName || targetDocId, userInput);
      return;
    }

    // 内容查询 → 按 Chat 模式处理
    if (this.isContentQuery(userInput)) {
      const targetDocId = this.resolveTargetDocId(userInput, contextDocId);
      if (!targetDocId) { yield sseError("无法确定目标文档"); return; }
      yield sseDocTarget(fileRegistry.get(targetDocId)?.originalName || targetDocId);
      yield* this.runChatMode(targetDocId, fileRegistry.get(targetDocId)?.originalName || targetDocId, userInput);
      return;
    }

    // Workflow 模式 → 由 wsAgentHandler 通过 createWorkflow 处理
    yield sseError("Workflow 模式请通过 WebSocket 使用");
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  private resolveTargetDocId(userInput: string, contextDocId?: string): string | undefined {
    const allDocs = fileRegistry.getAll();
    if (allDocs.length === 0) return undefined;
    if (allDocs.length === 1) return allDocs[0].docId;
    for (const doc of allDocs) {
      if (userInput.includes(doc.originalName)) return doc.docId;
      if (userInput.includes(doc.originalName.replace(/\.\w+$/, ""))) return doc.docId;
    }
    if (contextDocId && fileRegistry.get(contextDocId)) return contextDocId;
    return allDocs[0].docId;
  }

  async reset(): Promise<void> {
    await clearMemories();
    console.log("[GlobalAgent] 记忆已重置");
  }

  getStatus(): { initialized: boolean; docCount: number; memoryLength: number } {
    return { initialized: this.initialized, docCount: fileRegistry.count, memoryLength: getMemories().length };
  }
}

// ================================================================
// 单例
// ================================================================

let globalAgent: GlobalAgent | null = null;

export async function initGlobalAgent(config?: GlobalAgentConfig): Promise<void> {
  if (globalAgent) { console.log("[GlobalAgent] 已存在"); return; }
  globalAgent = new GlobalAgent();
  globalAgent.initialize(config);
}

export function getGlobalAgent(): GlobalAgent {
  if (!globalAgent) { globalAgent = new GlobalAgent(); console.warn("[GlobalAgent] 未初始化"); }
  return globalAgent;
}

export function resetGlobalAgent(): void { globalAgent?.reset(); }
