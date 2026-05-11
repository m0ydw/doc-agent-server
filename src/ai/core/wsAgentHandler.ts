/**
 * ================================================================
 * wsAgentHandler — WebSocket Agent 处理器（多 Agent 架构）
 *
 * 支持 LangGraph Supervisor 模式的流式事件。
 * 节点事件映射到前端 WebSocket 协议。
 * ================================================================
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { ChatOpenAI } from "@langchain/openai";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createParser } from "eventsource-parser";
import type { EventSourceMessage } from "eventsource-parser";
import { createWorkflow } from "../workflow/graph";
import { getGlobalAgent } from "../agent/globalAgent";
import config from "../../config";
import { logger } from "../../app";
import { getToolMetadataByName } from "../tools/sdkTools";

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
  orchestrator: "正在分析任务...",
  doc_analyst: "正在分析文档结构...",
  surgical_editor: "正在执行编辑...",
  template_filler: "正在填充数据...",
  reviewer: "正在验证结果...",
};

// ================================================================
// Writer 机制：允许节点发送自定义事件（兼容占位）
// ================================================================

/**
 * 从 RunnableConfig 中获取 writer 函数
 * 当前返回 no-op，节点通过标准 LangGraph 事件机制通信。
 */
export function getWriter(_config?: RunnableConfig): ((event: { type: string; data?: Record<string, unknown> }) => void) | undefined {
  return undefined;
}

// ================================================================
// 主入口
// ================================================================

export function attachAgentWs(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/agent" });
  const addr = httpServer.address();
  const port = addr && typeof addr === "object" ? addr.port : PORT;
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
      if (!llm) {
        send(ws, "error", { message: "Agent LLM 未初始化" });
        send(ws, "done", { id: msg.id });
        return;
      }
      const data = msg.data || {};

      if (data.mode === "chat") {
        handleChatMode(ws, msg);
        return;
      }

      // ===== 多 Agent 工作流 =====
      const abortController = new AbortController();
      currentAbortController = abortController;
      const graph = createWorkflow(llm);

      try {
        const stream = graph.streamEvents(
          {
            userInput: data.message || "",
            docId: data.docId || "",
            maxRetry: 3,
            retryCount: 0,
          },
          {
            version: "v2",
            streamMode: ["messages"] as const,
            signal: abortController.signal,
          }
        );

        for await (const event of stream) {
          switch (event.event) {

            // ===== LLM token 流 =====
            case "on_chat_model_stream": {
              let content = event.data?.chunk?.content || "";
              if (!content) break;
              const phase = event.metadata?.langgraph_node;
              const type = (phase === "generate" || phase === "surgical_editor") ? "content" : "thought";
              if (type === "content" && (phase === "surgical_editor" || phase === "template_filler")) {
                content = content
                  .replace(/\b(task_complete|sdk_\w+|SDK\w+Tool)\b/g, "")
                  .trim();
                if (!content) break;
              }
              send(ws, type, { content });
              break;
            }

            // ===== 节点开始 =====
            case "on_chain_start": {
              const nodeName = event.name;
              if (NODE_LABELS[nodeName]) {
                send(ws, "phase_start", { phase: nodeName });
                send(ws, "phase_status", { text: NODE_LABELS[nodeName] });
              }
              break;
            }

            // ===== 节点结束 =====
            case "on_chain_end": {
              const nodeName = event.name;
              const output = event.data?.output as Record<string, unknown> | undefined;

              if (nodeName === "orchestrator" && output?.analysis) {
                try {
                  const analysis = JSON.parse(output.analysis as string);
                  send(ws, "content", { content: `分析完成：${analysis.intent || "未知"}，委派 ${analysis.agentPlan?.length || 0} 个 Agent。` });
                } catch (e) { console.warn("[AgentWS] orchestrator JSON 解析失败:", (e as Error).message); }
              }

              if (nodeName === "doc_analyst" && output?.documentMaps) {
                try {
                  const maps = JSON.parse(output.documentMaps as string);
                  if (maps.length > 0 && maps[0].tables?.length > 0) {
                    const labels = maps[0].tables.flatMap((t: Record<string, unknown>) => (t.labels as unknown[]) || []);
                    send(ws, "content", { content: `文档结构分析完成，发现 ${maps[0].tables[0]?.cells?.length || 0} 个单元格，${labels.length} 个标签字段。` });
                  }
                } catch (e) { console.warn("[AgentWS] doc_analyst documentMaps 解析失败:", (e as Error).message); }
              }

              // TemplateFiller：从 fieldMappings 发送工具事件（纯确定性节点，不产生 LangGraph tool events）
              if (nodeName === "template_filler" && output?.fieldMappings) {
                try {
                  const mappings = JSON.parse(output.fieldMappings as string) as Array<{
                    fieldName: string; userValue: string; status: string; errorReason?: string;
                  }>;
                  for (const m of mappings) {
                    if (m.status === "written") {
                      send(ws, "tool_start", { tool: "写入文本", args: `写入 "${m.fieldName}"` });
                      send(ws, "tool_result", { success: true, tool: "写入文本", result: `${m.fieldName}: ${m.userValue}` });
                    } else if (m.status === "blocked") {
                      send(ws, "tool_start", { tool: "写入文本", args: `写入 "${m.fieldName}"` });
                      send(ws, "tool_result", { success: false, tool: "写入文本", result: m.errorReason || "数据守卫拦截" });
                    }
                  }
                } catch (e) { console.warn("[AgentWS] template_filler fieldMappings 解析失败:", (e as Error).message); }
              }

              if (nodeName === "reviewer" && output?.diffReport) {
                try {
                  const report = JSON.parse(output.diffReport as string);
                  const icon = report.result === "pass" ? "✅" : report.result === "partial" ? "⚠️" : "❌";
                  send(ws, "content", { content: `${icon} ${report.summary || "验证完成"}` });
                  send(ws, "summary", {
                    result: report.result === "pass" ? "success" : "partial",
                    summary_text: `${icon} ${report.summary || ""}`,
                    detail: JSON.stringify(report.details || []),
                    failed_tasks: [],
                  });
                } catch (e) { console.warn("[AgentWS] reviewer diffReport 解析失败:", (e as Error).message); }
              }

              if (output?.success !== undefined && output?.lastAgent === "SurgicalEditor") {
                send(ws, "content", { content: output.success ? "✅ 编辑完成" : "⚠️ 编辑完成，部分操作可能未成功" });
                send(ws, "summary", {
                  result: output.success ? "success" : "partial",
                  summary_text: output.success ? "✅ 编辑完成" : "⚠️ 编辑完成",
                  detail: "",
                  failed_tasks: [],
                });
              }

              if (nodeName) send(ws, "phase_end", { phase: nodeName });
              break;
            }

            // ===== 工具开始 =====
            case "on_tool_start": {
              const toolName = event.name || "";
              const toolInput = event.data?.input;
              const meta = getToolMetadataByName(toolName);
              if (meta?.showInUI) {
                const args = typeof toolInput === "string"
                  ? toolInput
                  : JSON.stringify(toolInput || {});
                send(ws, "tool_start", {
                  tool: meta.displayName,
                  args: meta.argsFormatter(toolInput as Record<string, unknown> || {}),
                });
              }
              break;
            }

            // ===== 工具结束 =====
            case "on_tool_end": {
              const toolName = event.name || "";
              const output = event.data?.output;
              const meta = getToolMetadataByName(toolName);
              if (meta?.showInUI) {
                const result = typeof output === "string" ? output : JSON.stringify(output || "");
                send(ws, "tool_result", {
                  success: true,
                  tool: meta.displayName,
                  result,
                });
              }
              break;
            }

            // ===== 自定义事件（writer 发射）=====
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
        if (e.name === "AbortError") {
          send(ws, "content", { content: "操作已取消。" });
        } else {
          send(ws, "error", { message: e.message || "Agent 执行失败" });
          send(ws, "summary", { result: "failed", summary_text: "❌ 执行出错", detail: e.message, failed_tasks: [] });
        }
      }

      send(ws, "done", { id: msg.id });
    });

    ws.on("close", () => {
      currentAbortController?.abort();
      currentAbortController = null;
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

/**
 * 使用标准 eventsource-parser 解析 SSE 流并转换为 WebSocket JSON 消息发送。
 */
async function processStream(stream: AsyncGenerator<string, void, unknown>, ws: WebSocket, msgId: string) {
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
