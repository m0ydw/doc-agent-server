/**
 * ================================================================
 * wsAgentHandler — WebSocket Agent 处理器（连接管理 + 模式分流）
 *
 * 【职责】
 * 1. 在 HTTP Server 上挂载 WebSocket 服务（/ws/agent）
 * 2. 管理客户端连接生命周期（连接/消息/断开）
 * 3. 解析前端消息并根据 mode 分流：
 *    - "chat" 模式 → handleChatMode() → 轻量自由对话
 *    - "workflow" 模式（默认）→ dispatchWorkflow() → 多 Agent 协作
 *
 * 【重构说明】
 * workflow 模式的事件处理逻辑已抽取到 workflowStreamHandler.ts，
 * 本文件只保留连接管理和模式分流，代码量大幅精简。
 *
 * 【整体流程】
 * 1. attachAgentWs() 在 server.ts 启动时被调用，挂载 WS 服务
 * 2. 前端通过 ws://localhost:3000/ws/agent 连接并发送 agent_message
 * 3. 根据 mode 字段分流到不同处理链路
 * 4. 处理结果通过 send() 写入 WebSocket 返回前端
 * ================================================================
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createParser } from "eventsource-parser";
import type { EventSourceMessage } from "eventsource-parser";
import { getGlobalAgent } from "../agent/globalAgent";
import { dispatchWorkflow } from "./workflowStreamHandler";
import { dispatchToolAgentWorkflow, shouldUseToolAgentWorkflow, type ToolAgentDispatchInput, type ToolAgentDispatchResult } from "../toolAgent/toolAgentDispatchAdapter";
import { resolveToolAgentProviderModeForEntry, explainToolAgentProviderModeForEntry, type ToolAgentProviderMode } from "../toolAgent/toolAgentProviderModes";
import type { LangChainLikeLlm } from "../toolAgent/llmDecisionClientAdapter";
import config from "../../config";
import { logger } from "../../app";

const PORT = config.PORT;

// ================================================================
// 消息类型定义 — 前端 WebSocket 客户端发送的消息结构
// ================================================================

/** 前端发送给 Agent WS 的客户端消息 */
interface ClientMessage {
  /** "agent_message" 发起一轮对话/编辑；"cancel" 中止当前任务 */
  type: "agent_message" | "cancel";
  /** 消息唯一标识，用于前端匹配请求-响应 */
  id: string;
  data?: {
    /** 用户自然语言输入 */
    message?: string;
    /** 目标文档 ID */
    docId?: string;
    /** "workflow" 多Agent协作（默认）；"chat" 自由对话 */
    mode?: "workflow" | "chat";
    /** 前端传来的模型配置参数（可选） */
    toolAgentMode?: "disabled" | "planning_only" | "shadow" | "enabled" | string;
    toolAgentProviderMode?: string;
    referenceDocId?: string;
    targetDocId?: string;
    modelConfig?: Record<string, unknown>;
  };
}

// ================================================================
// Writer 机制：允许节点发送自定义事件（兼容占位）
// ================================================================

/**
 * 从 RunnableConfig 中获取 writer 函数
 * 当前始终返回 undefined，节点通过标准 LangGraph 事件机制通信。
 * @param _config LangChain RunnableConfig（当前未使用）
 */
export function getWriter(_config?: RunnableConfig): ((event: { type: string; data?: Record<string, unknown> }) => void) | undefined {
  return undefined;
}

// ================================================================
// 主入口：在 HTTP Server 上挂载 WebSocket 服务
// ================================================================

/**
 * 在现有 HTTP Server 上挂载 WebSocket Agent 服务
 *
 * 【调用时机】由 server.ts 在服务器启动时调用，与 HTTP 共用端口
 * 【路径】/ws/agent — 前端通过 new WebSocket("ws://localhost:3000/ws/agent") 连接
 * 【生命周期】
 *   connection → 创建 abortController（用于取消）
 *   message → 解析 JSON → 根据 mode 分流到 chat / workflow
 *   close → 调用 abort() 中止进行中的任务
 *
 * @param httpServer - Node.js HTTP Server 实例
 */
export function attachAgentWs(httpServer: Server): void {
  // 在现有 HTTP Server 上创建 WebSocketServer，路径为 /ws/agent
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/agent" });
  const addr = httpServer.address();
  const port = addr && typeof addr === "object" ? addr.port : PORT;
  logger.info("[AgentWS] 已启动: ws://localhost:" + port + "/ws/agent");

  // 每次有前端客户端连接时触发
  wss.on("connection", (ws: WebSocket) => {
    logger.info("[AgentWS] 客户端已连接");
    // 每个连接拥有自己独立的取消控制器，互不干扰
    let currentAbortController: AbortController | null = null;

    // 接收到前端消息时触发
    ws.on("message", async (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, "error", { message: "无效的 JSON 消息" });
        return;
      }

      // 取消消息：中止当前进行中的 Agent 任务
      if (msg.type === "cancel") {
        currentAbortController?.abort();
        currentAbortController = null;
        return;
      }

      // 只处理 agent_message 类型，忽略其他
      if (msg.type !== "agent_message") return;

      // 校验 Agent 是否已初始化
      const agent = getGlobalAgent();
      if (!agent.isInitialized) {
        send(ws, "error", { message: "Agent 未初始化" });
        send(ws, "done", { id: msg.id });
        return;
      }

      // 校验 LLM 实例是否就绪
      const llm = agent.currentLlm;
      if (!llm) {
        send(ws, "error", { message: "Agent LLM 未初始化" });
        send(ws, "done", { id: msg.id });
        return;
      }

      const data = msg.data || {};

      // ============================================================
      // 模式分流
      // ============================================================

      // Chat 模式 → 自由对话（轻量级，不走多 Agent 工作流）
      if (data.mode === "chat") {
        handleChatMode(ws, msg);
        return;
      }

      // Workflow 模式（默认）→ 多 Agent 协作
      // 创建取消控制器，用户可通过发送 cancel 消息中止工作流
      const abortController = new AbortController();
      currentAbortController = abortController;

      // 创建适配器：将 ws 相关的 send 包装为纯回调，注入到 dispatchWorkflow
      const sendMsg = (type: string, dataPayload?: Record<string, unknown>) => {
        send(ws, type, dataPayload);
      };

      try {
        // 委托给 workflowStreamHandler 处理工作流事件流
        const toolAgentMode = typeof data.toolAgentMode === "string"
          ? data.toolAgentMode as "disabled" | "planning_only" | "shadow" | "enabled"
          : undefined;
        const envEnabled = process.env.TOOL_AGENT_WORKFLOW_ENABLED === "true";

        // 读取 providerMode（hidden flag）
        const rawToolAgentProviderMode = (data as Record<string, unknown>).toolAgentProviderMode;
        const providerMode = resolveToolAgentProviderModeForEntry({
          toolAgentMode,
          rawToolAgentProviderMode,
          hasLlm: Boolean(llm),
        });

        // Diagnostic logging: 仅在 Tool Agent hidden flag 相关时打印
        const hasToolAgentHint = envEnabled || toolAgentMode !== undefined || rawToolAgentProviderMode !== undefined;
        if (hasToolAgentHint) {
          const explanation = explainToolAgentProviderModeForEntry({
            toolAgentMode,
            rawToolAgentProviderMode,
            hasLlm: Boolean(llm),
          });
          const passesLlmToDispatch = providerMode === "llm_planning_only";

          logger.info({
            id: msg.id,
            toolAgentEnabled: envEnabled,
            toolAgentMode: toolAgentMode ?? "undefined",
            rawToolAgentProviderMode: typeof rawToolAgentProviderMode === "string" ? rawToolAgentProviderMode : "undefined",
            resolvedProviderMode: providerMode,
            reason: explanation.reason,
            hasLlm: Boolean(llm),
            passesLlmToDispatch,
            hasSignal: Boolean(abortController.signal),
          }, "[tool-agent] ws entry provider mode resolved");

          if (providerMode === "llm_planning_only") {
            logger.info({ id: msg.id }, "[tool-agent] llm_planning_only enabled for ws entry");
          } else if (typeof rawToolAgentProviderMode === "string" && rawToolAgentProviderMode === "llm_planning_only") {
            logger.warn({
              id: msg.id,
              reason: explanation.reason,
            }, "[tool-agent] llm_planning_only requested but fallback to static_planning_only");
          }
        }

        if (shouldUseToolAgentWorkflow({
          mode: data.mode,
          toolAgentMode,
          envEnabled,
        })) {
          logger.info({
            id: msg.id,
            toolAgentMode,
            providerMode,
            hasLlm: Boolean(llm),
          }, "[tool-agent] ws entry dispatch selected");

          try {
            const toolAgentResult = await dispatchToolAgentWorkflow({
              userInput: data.message || "",
              docId: data.docId || "",
              referenceDocId: typeof data.referenceDocId === "string" ? data.referenceDocId : undefined,
              targetDocId: typeof data.targetDocId === "string" ? data.targetDocId : data.docId,
              mode: data.mode,
              toolAgentMode,
              envEnabled,
              providerMode,
              llm: providerMode === "llm_planning_only" ? llm : undefined,
              signal: abortController.signal,
            });

            logger.info({
              id: msg.id,
              status: toolAgentResult.result.status,
              providerMode,
            }, "[tool-agent] ws entry dispatch completed");

            // 发送 tool_agent_result 结构化结果
            const resultEvent = buildToolAgentWsResultEvent({
              id: msg.id,
              providerMode,
              result: toolAgentResult,
            });
            sendMsg(resultEvent.type, { id: resultEvent.id, ...resultEvent.data });

            for (const message of toolAgentResult.messages) {
              sendMsg(message.type, message.data);
            }
            send(ws, "done", { id: msg.id });
            return;
          } catch (toolAgentError) {
            const errorMessage = toolAgentError instanceof Error ? toolAgentError.message : String(toolAgentError);
            logger.error({
              id: msg.id,
              error: errorMessage,
              providerMode,
            }, "[tool-agent] ws entry dispatch failed");

            // 发送安全的失败结果（不暴露 stack trace）
            const errorResultEvent = buildToolAgentWsErrorResultEvent({
              id: msg.id,
              providerMode,
            });
            sendMsg(errorResultEvent.type, { id: errorResultEvent.id, ...errorResultEvent.data });

            send(ws, "done", { id: msg.id });
            return;
          }
        }

        await dispatchWorkflow(
          llm,
          data.message || "",
          data.docId || "",
          abortController.signal,
          sendMsg,
        );
      } catch (e: any) {
        // 判断是否为用户主动取消（AbortController.abort() 触发）
        if (e.name === "AbortError") {
          send(ws, "content", { content: "操作已取消。" });
        } else {
          // 其他异常 → 发送 error 和 failed summary 给前端
          send(ws, "error", { message: e.message || "Agent 执行失败" });
          send(ws, "summary", {
            result: "failed",
            summary_text: "❌ 执行出错",
            detail: e.message,
            failed_tasks: [],
          });
        }
      }

      // 无论成功或失败，都发送 done 消息，让前端知道本轮处理已结束
      send(ws, "done", { id: msg.id });
    });

    // 前端客户端断开连接时：取消进行中的任务并清理资源
    ws.on("close", () => {
      currentAbortController?.abort();
      currentAbortController = null;
      logger.info("[AgentWS] 已断开");
    });
  });
}

// ================================================================
// 辅助函数：send — 向 WebSocket 客户端发送 JSON 消息
// ================================================================

/**
 * 向 WebSocket 客户端发送 JSON 消息
 * 先检查连接状态是否为 OPEN，避免向断开的连接发送消息导致异常
 * @param ws   目标 WebSocket 连接
 * @param type 消息类型（编码为 { type, data } JSON）
 * @param data 消息负载
 */
function send(ws: WebSocket, type: string, data?: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// ================================================================
// 纯 helper：构造 dispatchToolAgentWorkflow 输入
// ================================================================

/**
 * 构造 dispatchToolAgentWorkflow 的输入参数
 *
 * 纯函数，无副作用，不调用 LLM，不读取 env，不发送 ws event。
 * 只负责把 wsAgentHandler 里已有变量整理成 dispatch input。
 */
export interface BuildToolAgentDispatchInputParams {
  message: string;
  docId: string;
  referenceDocId?: string;
  targetDocId?: string;
  mode?: string;
  toolAgentMode?: "disabled" | "planning_only" | "shadow" | "enabled";
  rawToolAgentProviderMode?: unknown;
  envEnabled: boolean;
  hasLlm: boolean;
  llm?: LangChainLikeLlm;
  signal?: AbortSignal;
  maxSteps?: number;
  referenceTemplates?: unknown;
  targetInspection?: unknown;
}

export function buildToolAgentDispatchInputFromWsEntry(
  params: BuildToolAgentDispatchInputParams,
): ToolAgentDispatchInput {
  const providerMode = resolveToolAgentProviderModeForEntry({
    toolAgentMode: params.toolAgentMode,
    rawToolAgentProviderMode: params.rawToolAgentProviderMode,
    hasLlm: params.hasLlm,
  });

  return {
    userInput: params.message,
    docId: params.docId,
    referenceDocId: params.referenceDocId,
    targetDocId: params.targetDocId,
    mode: params.mode,
    toolAgentMode: params.toolAgentMode,
    envEnabled: params.envEnabled,
    providerMode,
    llm: providerMode === "llm_planning_only" ? params.llm : undefined,
    signal: params.signal,
    maxSteps: params.maxSteps,
    referenceTemplates: params.referenceTemplates,
    targetInspection: params.targetInspection,
  };
}

// ================================================================
// 纯 helper：构造 Tool Agent WS result 事件
// ================================================================

export interface ToolAgentWsResultEvent {
  type: "tool_agent_result";
  id: string;
  data: {
    source: "tool_agent";
    providerMode: ToolAgentProviderMode;
    status: string;
    summary: string;
    stepCount: number;
    eventCount: number;
    safeToolsOnly: true;
  };
}

export function buildToolAgentWsResultEvent(params: {
  id: string;
  providerMode: ToolAgentProviderMode;
  result: ToolAgentDispatchResult;
}): ToolAgentWsResultEvent {
  const stepCount = params.result.loopResult?.state?.toolHistory?.length ?? 0;
  return {
    type: "tool_agent_result",
    id: params.id,
    data: {
      source: "tool_agent",
      providerMode: params.providerMode,
      status: params.result.result.status,
      summary: params.result.result.summary ?? "",
      stepCount,
      eventCount: params.result.events.length,
      safeToolsOnly: true,
    },
  };
}

export function buildToolAgentWsErrorResultEvent(params: {
  id: string;
  providerMode: ToolAgentProviderMode;
}): ToolAgentWsResultEvent {
  return {
    type: "tool_agent_result",
    id: params.id,
    data: {
      source: "tool_agent",
      providerMode: params.providerMode,
      status: "failed",
      summary: "Tool Agent dispatch failed.",
      stepCount: 0,
      eventCount: 0,
      safeToolsOnly: true,
    },
  };
}

// ================================================================
// Chat 模式处理器
// ================================================================

/**
 * Chat 模式处理器：将用户消息通过 GlobalAgent 的 streamProcess 以 SSE 流方式返回
 *
 * Chat 模式与 workflow 模式的区别：
 * - workflow 模式：走 LangGraph 多 Agent 协作链路，有明确的阶段和节点
 * - chat 模式：走 GlobalAgent 的单路流式对话，更轻量，适合自由问答
 *
 * @param ws  WebSocket 连接
 * @param msg 客户端消息
 */
function handleChatMode(ws: WebSocket, msg: ClientMessage) {
  const agent = getGlobalAgent();
  const data = msg.data || {};
  try {
    // 调用 GlobalAgent.streamProcess 获取 SSE 流
    const stream = agent.streamProcess({
      message: data.message || "",
      contextDocId: data.docId,
      mode: "chat",
    });
    processStream(stream, ws, msg.id);
  } catch (e: any) {
    send(ws, "error", { message: e.message });
    send(ws, "done", { id: msg.id });
  }
}

/**
 * 使用标准 eventsource-parser 解析 SSE 流并转换为 WebSocket JSON 消息发送
 *
 * 为什么用 eventsource-parser？
 * SSE 格式为 "event: type\ndata: json\n\n"，eventsource-parser 能正确解析多行 data、
 * 按事件类型分发，避免手动字符串分割导致的解析错误。
 *
 * 工作流程：
 * 1. 从 stream 逐 chunk 获取 SSE 帧文本
 * 2. 喂给 eventsource-parser 解析
 * 3. 解析出事件后转为 WS JSON 消息发送给前端
 *
 * @param stream SSE 流的异步生成器
 * @param ws     WebSocket 连接
 * @param msgId  消息 ID，在 done 时回传
 */
async function processStream(
  stream: AsyncGenerator<string, void, unknown>,
  ws: WebSocket,
  msgId: string,
) {
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!event.event || !event.data) return;
      try {
        const parsed = JSON.parse(event.data);
        send(ws, event.event, parsed);
      } catch {
        console.warn("[AgentWS] SSE 帧 JSON 解析失败:", event.data.slice(0, 80));
      }
    },
  });

  for await (const chunk of stream) {
    if (ws.readyState !== WebSocket.OPEN) break;
    parser.feed(chunk);
  }
  send(ws, "done", { id: msgId });
}
