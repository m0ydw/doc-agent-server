/**
 * ================================================================
 * wsAgentHandler — WebSocket Agent 处理器
 * ================================================================
 *
 * 替代原来的 HTTP SSE 方案。使用 LangGraph 标准的 streamEvents 模式，
 * 将 on_chat_model_stream / on_chain_start/end 映射为结构化 JSON 消息。
 *
 * 【LangGraph 标准流式映射】
 *   on_chat_model_stream  → 缓冲 tokens → { type: "thought"/"content" }
 *   on_chain_start        → { type: "phase_status" }
 *   on_chain_end          → { type: "phase_end" } + 状态汇总
 *   (execute 节点的工具事件通过 getWriter 发射)
 *
 * 【WebSocket 消息协议（Server → Client）】
 *   { type: "thought",      data: { content: "..." } }
 *   { type: "content",      data: { content: "..." } }
 *   { type: "phase_start",  data: { phase: "analyze" } }
 *   { type: "phase_end",    data: { phase: "analyze" } }
 *   { type: "phase_status", data: { text: "正在分析..." } }
 *   { type: "tool_start",   data: { tool: "搜索文本", args: "..." } }
 *   { type: "tool_result",  data: { success: true, tool: "搜索文本", result: "..." } }
 *   { type: "doc_target",   data: { fileName: "文档.docx" } }
 *   { type: "summary",      data: { result: "success", summary_text: "✅ 完成" } }
 *   { type: "error",        data: { message: "错误信息" } }
 *   { type: "done",         data: { id: "msg-1" } }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { ChatOpenAI } from "@langchain/openai";
import type { PhaseStreamStrategy } from "../agent/phaseStrategy";
import { createWorkflow } from "../workflow/graph";
import { getGlobalAgent } from "../agent/globalAgent";
import { getToolMetadataByName } from "../tools/sdkTools";
import { getWriter } from "@langchain/langgraph";

// ================================================================
// 常量
// ================================================================

const STREAM_CHUNK_SIZE = 60;
const STREAM_CUT_WINDOW = 64;

// ================================================================
// 消息类型
// ================================================================

interface ClientMessage {
  type: "agent_message" | "cancel";
  id: string;
  data?: {
    message?: string;
    docId?: string;
    mode?: "workflow" | "chat";
    modelConfig?: Record<string, unknown>;
  };
}

interface ServerMessage {
  type: string;
  data?: Record<string, unknown>;
}

// ================================================================
// 流式切割辅助
// ================================================================

function cutStream(buffer: string): { chunk: string; rest: string } {
  if (buffer.length < STREAM_CHUNK_SIZE) return { chunk: "", rest: buffer };
  const cutIdx = Math.max(
    buffer.lastIndexOf("\n\n", STREAM_CUT_WINDOW) + 2,
    buffer.lastIndexOf("\n", STREAM_CUT_WINDOW) + 1,
    buffer.lastIndexOf(" ", STREAM_CUT_WINDOW) + 1,
    STREAM_CHUNK_SIZE
  );
  return { chunk: buffer.slice(0, cutIdx), rest: buffer.slice(cutIdx) };
}

// ================================================================
// 节点名称 → 阶段状态中文
// ================================================================

const NODE_LABELS: Record<string, string> = {
  docTarget: "正在定位目标文档...",
  analyze: "正在分析您的需求...",
  plan: "正在制定执行计划...",
  execute: "正在处理文档...",
  generate: "正在生成回答...",
  validate: "正在验证结果...",
};

// ================================================================
// 主入口：挂载 WS 处理器到 HTTP Server
// ================================================================

export function attachAgentWs(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/agent" });

  console.log("[AgentWS] WebSocket 服务已启动: ws://localhost" + (httpServer as any).address()?.port + "/ws/agent");

  wss.on("connection", (ws: WebSocket) => {
    console.log("[AgentWS] 客户端已连接");
    let cancelled = false;

    ws.on("message", async (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, "error", { message: "无效的 JSON 消息" });
        return;
      }

      if (msg.type === "cancel") {
        cancelled = true;
        return;
      }

      if (msg.type !== "agent_message") return;

      const agent = getGlobalAgent();
      if (!agent.isInitialized) {
        send(ws, "error", { message: "Agent 未初始化，请配置 API Key" });
        send(ws, "done", { id: msg.id });
        return;
      }

      const llm = (agent as any).llm as ChatOpenAI;
      const strategy = (agent as any).phaseStrategy as PhaseStreamStrategy;
      const data = msg.data || {};

      // Chat 模式暂时走旧路径（通过 globalAgent.streamProcess）
      if (data.mode === "chat") {
        handleChatMode(ws, msg);
        return;
      }

      // ===== LangGraph 工作流 =====
      cancelled = false;
      const graph = createWorkflow(llm, strategy);

      const initialState = {
        userInput: data.message || "",
        docId: data.docId || "",
        maxRetry: 3,
        retryCount: 0,
      };

      try {
        const stream = graph.streamEvents(initialState, {
          version: "v2",
          streamMode: ["updates", "custom"],
        });

        let tokenBuffer = "";
        let currentPhase: string | null = null;

        for await (const event of stream) {
          if (cancelled) break;

          switch (event.event) {

            // ===== LLM token 流 =====
            case "on_chat_model_stream": {
              const content = event.data?.chunk?.content || "";
              tokenBuffer += content;

              const { chunk, rest } = cutStream(tokenBuffer);
              if (chunk) {
                const phase = event.metadata?.langgraph_node;
                const type = (phase === "generate") ? "content" : "thought";
                send(ws, type, { content: chunk });
                tokenBuffer = rest;
              }
              break;
            }

            // ===== 节点开始 =====
            case "on_chain_start": {
              const nodeName = event.name;
              if (NODE_LABELS[nodeName]) {
                currentPhase = nodeName;
                send(ws, "phase_status", { text: NODE_LABELS[nodeName] });
                send(ws, "phase_start", { phase: nodeName });
              }
              break;
            }

            // ===== 节点结束 =====
            case "on_chain_end": {
              const nodeName = event.name;
              // flush tokenBuffer 剩余
              if (tokenBuffer.trim()) {
                const type = (nodeName === "generate") ? "content" : "thought";
                send(ws, type, { content: tokenBuffer.trim() });
                tokenBuffer = "";
              }
              // 发送 phase_end
              if (nodeName) {
                send(ws, "phase_end", { phase: nodeName });
              }

              // ===== 特殊节点处理 =====
              if (nodeName === "docTarget") {
                const output = event.data?.output;
                if (output?.targetDocName) {
                  send(ws, "doc_target", { fileName: output.targetDocName });
                }
              }
              break;
            }

            // ===== 自定义事件（工具调用等）=====
            case "on_custom_event": {
              const custom = event.data as Record<string, unknown> | undefined;
              if (custom && typeof custom === "object") {
                send(ws, (custom.type as string) || "custom", custom.data as Record<string, unknown>);
              }
              break;
            }
          }
        }
      } catch (e: any) {
        send(ws, "error", { message: e.message || "Agent 执行失败" });
      }

      send(ws, "summary", {
        result: "success",
        summary_text: "✅ 所有任务执行完成",
        detail: "",
        failed_tasks: [],
      });
      send(ws, "done", { id: msg.id });
    });

    ws.on("close", () => {
      cancelled = true;
      console.log("[AgentWS] 客户端已断开");
    });
  });
}

// ================================================================
// 辅助函数
// ================================================================

function send(ws: WebSocket, type: string, data?: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function handleChatMode(ws: WebSocket, msg: ClientMessage) {
  const agent = getGlobalAgent();
  const data = msg.data || {};

  try {
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

// ================================================================
// 旧版兼容：处理 AsyncGenerator 流式输出
// ================================================================

async function processStream(
  stream: AsyncGenerator<string, void, unknown>,
  ws: WebSocket,
  _msgId: string
) {
  // 注意：此函数仅用于 chat 模式的临时兼容
  // workflow 模式已完全迁移到 LangGraph streamEvents
  for await (const chunk of stream) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(chunk);
  }
  send(ws, "done", { id: _msgId });
}
