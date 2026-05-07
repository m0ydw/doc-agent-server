/**
 * ================================================================
 * wsAgentHandler — WebSocket Agent 处理器（LangGraph 标准模式）
 * ================================================================
 *
 * 【标准流式映射】
 *   streamMode: ["messages", "custom"]
 *   - "messages" → on_chat_model_stream → 实时逐字 LLM tokens (thought/content)
 *   - "custom"   → on_custom_event        → 实时工具调用 (tool_start/result)
 *   - on_chain_end (始终触发)             → 阶段结束 + 对话式摘要 + 最终结果
 *
 * 【WebSocket 消息协议（Server → Client）】
 *   { type: "phase_start",  data: { phase: "analyze" } }
 *   { type: "phase_status", data: { text: "正在分析您的需求..." } }
 *   { type: "thought",      data: { content: "逐字流式思考..." } }
 *   { type: "content",      data: { content: "逐字流式回答..." } }
 *   { type: "phase_end",    data: { phase: "analyze" } }
 *   { type: "tool_start",   data: { tool: "搜索文本", args: "搜索 "公司"" } }
 *   { type: "tool_result",  data: { success: true, tool: "搜索文本", result: "找到3处" } }
 *   { type: "doc_target",   data: { fileName: "文档.docx" } }
 *   { type: "todo_list",    data: { tasks: [...] } }
 *   { type: "summary",      data: { result: "success", summary_text: "✅", detail: "", failed_tasks: [] } }
 *   { type: "done",         data: { id: "msg-1" } }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { ChatOpenAI } from "@langchain/openai";
import type { PhaseStreamStrategy } from "../agent/phaseStrategy";
import { createWorkflow } from "../workflow/graph";
import { getGlobalAgent } from "../agent/globalAgent";
import config from "../../config";
import { logger } from "../../app";
import { buildAnalysisSummary, buildPlanSummary, buildValidateSummary, extractTodoList } from "./summaryBuilder";

const PORT = config.PORT;

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

// ================================================================
// 节点 → 中文标签
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
// 主入口
// ================================================================

export function attachAgentWs(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/agent" });
  const addr = httpServer.address();
  const port = addr && typeof addr === 'object' ? addr.port : PORT;
  logger.info("[AgentWS] 已启动: ws://localhost:" + port + "/ws/agent");

  wss.on("connection", (ws: WebSocket) => {
    logger.info("[AgentWS] 客户端已连接");
    let currentAbortController: AbortController | null = null;

    ws.on("message", async (raw: Buffer) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch {
        send(ws, "error", { message: "无效的 JSON 消息" }); return;
      }
      if (msg.type === "cancel") {
        // 取消当前请求
        currentAbortController?.abort();
        currentAbortController = null;
        return;
      }
      if (msg.type !== "agent_message") return;

      const agent = getGlobalAgent();
      if (!agent.isInitialized) {
        send(ws, "error", { message: "Agent 未初始化" });
        send(ws, "done", { id: msg.id });
        return;
      }

      const llm = agent.currentLlm;
      const strategy = agent.currentStrategy;
      if (!llm || !strategy) {
        send(ws, "error", { message: "Agent LLM/策略未初始化" });
        send(ws, "done", { id: msg.id });
        return;
      }
      const data = msg.data || {};

      if (data.mode === "chat") {
        handleChatMode(ws, msg);
        return;
      }

      // ===== LangGraph 工作流（标准 streamMode）=====
      const abortController = new AbortController();
      currentAbortController = abortController;
      const graph = createWorkflow(llm, strategy);

      try {
        const stream = graph.streamEvents(
          { userInput: data.message || "", docId: data.docId || "", maxRetry: 3, retryCount: 0 },
          { version: "v2", streamMode: ["messages", "custom"], signal: abortController.signal }
        );

        let currentPhase: string | null = null;

        for await (const event of stream) {

          switch (event.event) {

            // ===== LLM token 流（逐 token 发送，前端累积渲染）=====
            case "on_chat_model_stream": {
              const content = event.data?.chunk?.content || "";
              if (!content) break;
              const phase = event.metadata?.langgraph_node;
              const type = (phase === "generate") ? "content" : "thought";
              send(ws, type, { content });
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

            // ===== 节点结束 → 阶段摘要 + 最终结果 =====
            case "on_chain_end": {
              const nodeName = event.name;
              const output = event.data?.output as Record<string, unknown> | undefined;

              // ★ 节点特定事件
              if (nodeName === "docTarget" && output?.targetDocName) {
                send(ws, "doc_target", { fileName: output.targetDocName as string });
              }

              if (nodeName === "analyze" && output?.analysis) {
                const summary = buildAnalysisSummary(output.analysis as string);
                if (summary) send(ws, "content", { content: summary });
              }

              if (nodeName === "plan" && output?.planJson) {
                const summary = buildPlanSummary(output.planJson as string);
                if (summary) send(ws, "content", { content: summary });
                const todos = extractTodoList(output.planJson as string);
                if (todos.length > 0) send(ws, "todo_list", { tasks: todos });
              }

              if (nodeName === "validate") {
                if (output?.validateJson) {
                  const summary = buildValidateSummary(output.validateJson as string);
                  if (summary) send(ws, "content", { content: summary });
                }
                // 发射最终 summary（基于实际验证结果）
                const success = output?.success === true;
                const needsUserInput = output?.needsUserInput === true;
                const retryable = output?.retryable !== false;
                send(ws, "summary", {
                  result: success ? "success" : needsUserInput ? "intervention" : retryable ? "retry" : "failed",
                  summary_text: success ? "✅ 所有任务执行完成" : "⚠️ 需要关注",
                  detail: "",
                  failed_tasks: [],
                });
              }

              // 发送 phase_end
              if (nodeName) send(ws, "phase_end", { phase: nodeName });
              break;
            }

            // ===== 工具事件（实时）=====
            case "on_custom_event": {
              const custom = event.data as Record<string, unknown> | undefined;
              if (custom?.type) {
                send(ws, custom.type as string, custom.data as Record<string, unknown>);
              }
              break;
            }
          }
        }
      } catch (e: any) {
        send(ws, "error", { message: e.message || "Agent 执行失败" });
        send(ws, "summary", { result: "failed", summary_text: "❌ 执行出错", detail: e.message, failed_tasks: [] });
      }

      send(ws, "done", { id: msg.id });
    });

    ws.on("close", () => {
      currentAbortController?.abort();
      logger.info("[AgentWS] 已断开");
    });
  });
}

// ================================================================
// 辅助函数
// ================================================================

function send(ws: WebSocket, type: string, data?: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

function handleChatMode(ws: WebSocket, msg: ClientMessage) {
  const agent = getGlobalAgent();
  const data = msg.data || {};
  try {
    const stream = agent.streamProcess({ message: data.message || "", contextDocId: data.docId, mode: "chat" });
    processStream(stream, ws, msg.id);
  } catch (e: any) {
    send(ws, "error", { message: e.message });
    send(ws, "done", { id: msg.id });
  }
}

async function processStream(stream: AsyncGenerator<string, void, unknown>, ws: WebSocket, msgId: string) {
  for await (const chunk of stream) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(chunk);
  }
  send(ws, "done", { id: msgId });
}
