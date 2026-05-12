/**
 * ================================================================
 * wsAgentHandler — WebSocket Agent 处理器（多 Agent 架构）
 *
 * 支持 LangGraph Supervisor 模式的流式事件。
 * 节点事件映射到前端 WebSocket 协议。
 *
 * 【整体流程】
 * 1. attachAgentWs() 在 HTTP Server 上挂载 WebSocket 服务
 * 2. 客户端通过 ws://host/ws/agent 连接并发送 agent_message
 * 3. 根据 mode 字段分流：
 *    - "chat" 模式 → 调用 GlobalAgent.streamProcess() 的 SSE 流
 *    - "workflow" 模式（默认）→ 创建 LangGraph 工作流图并流式执行
 * 4. LangGraph 的 streamEvents 产生标准事件，映射为前端可识别的 WS JSON 消息
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
    modelConfig?: Record<string, unknown>;
  };
}

// ================================================================
// 节点 → 中文标签映射 — 前端 status 栏展示当前正在执行的阶段
// 这些标签会在 streamEvents 的 on_chain_start 事件中被发送给前端
// ================================================================

const NODE_LABELS: Record<string, string> = {
  /** 总调度节点：分析用户意图并分配子任务 */
  orchestrator: "正在分析任务...",
  /** 文档考古学家：解析文档表格结构和标签字段 */
  doc_analyst: "正在分析文档结构...",
  /** 精准文本外科医生：基于 LLM Tool Calling 执行文本编辑 */
  surgical_editor: "正在执行编辑...",
  /** 填表专员：确定性写入表单字段数据 */
  template_filler: "正在填充数据...",
  /** 质检员：逐字段验证编辑结果并生成 Diff 报告 */
  reviewer: "正在验证结果...",
};

// ================================================================
// Writer 机制：允许节点发送自定义事件（兼容占位）
// 设计意图：节点在工作流执行过程中可能需要发送进度、阶段状态等自定义事件，
// 当前通过 LangGraph 的 on_custom_event 机制替代（参见下方事件映射）。
// 该函数返回 undefined 意味着节点无需自行持有 writer 引用。
// ================================================================

/**
 * 从 RunnableConfig 中获取 writer 函数
 * @param _config LangChain RunnableConfig（当前未使用）
 * @returns 当前始终返回 undefined，节点通过标准 LangGraph 事件机制通信
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
 * 【调用时机】由 app.ts 在服务器启动时调用，与 HTTP 共用端口
 * 【路径】/ws/agent — 前端通过 `new WebSocket("ws://localhost:3000/ws/agent")` 连接
 * 【生命周期】
 *   connection → 创建 abortController（用于取消）
 *   message → 解析 JSON → 根据 mode 分流到 chat/workflow
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
      try { msg = JSON.parse(raw.toString()); } catch {
        send(ws, "error", { message: "无效的 JSON 消息" }); return;
      }
      // 取消消息：中止当前进行中的 Agent 任务
      if (msg.type === "cancel") {
        currentAbortController?.abort();
        currentAbortController = null;
        return;
      }
      // 只处理 agent_message 类型，忽略其他
      if (msg.type !== "agent_message") return;

      const agent = getGlobalAgent();
      // 校验 Agent 是否已通过 /api/agent/init 初始化
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

      // === 模式分流：chat → 自由对话模式 ===
      if (data.mode === "chat") {
        handleChatMode(ws, msg);
        return;
      }

      // ===== 多 Agent 工作流（workflow 模式，默认）=====
      // 创建取消控制器，用户可通过发送 cancel 消息中止工作流
      const abortController = new AbortController();
      currentAbortController = abortController;
      // 基于当前 LLM 实例创建 LangGraph 工作流图
      const graph = createWorkflow(llm);

      try {
        // 启动 LangGraph 工作流流式执行
        // streamEvents 会产生标准 LangGraph 事件流，按事件类型分发给前端
        const stream = graph.streamEvents(
          {
            // 初始状态：从 AgentState 类型定义中获取字段
            userInput: data.message || "",
            docId: data.docId || "",
            maxRetry: 3,
            retryCount: 0,
          },
          {
            version: "v2",                          // LangGraph 流式事件 v2 格式
            streamMode: ["messages"] as const,      // 流模式：同时获取消息和事件
            signal: abortController.signal,         // 传递取消信号
          }
        );

        // 遍历 LangGraph 流式事件，将每个事件映射为 WS 消息发送给前端
        for await (const event of stream) {
          switch (event.event) {

            // ===== LLM Token 流：逐 token 推送 LLM 思考或输出 =====
            case "on_chat_model_stream": {
              let content = event.data?.chunk?.content || "";
              if (!content) break;
              // 从 langgraph_node metadata 判断当前是哪个节点输出
              const phase = event.metadata?.langgraph_node;
              // generate 和 surgical_editor 节点输出的是"内容"，其它节点输出的是"思考过程"
              const type = (phase === "generate" || phase === "surgical_editor") ? "content" : "thought";
              // 对 surgical_editor / template_filler 节点的输出过滤工具调用相关文本，
              // 避免将 SDK 工具调用名称暴露给用户
              if (type === "content" && (phase === "surgical_editor" || phase === "template_filler")) {
                content = content
                  .replace(/\b(task_complete|sdk_\w+|SDK\w+Tool)\b/g, "")
                  .trim();
                if (!content) break;
              }
              send(ws, type, { content });
              break;
            }

            // ===== 节点开始：通知前端当前进入哪个阶段 =====
            case "on_chain_start": {
              const nodeName = event.name;
              // 只有 NODE_LABELS 中定义的节点才发送阶段状态
              if (NODE_LABELS[nodeName]) {
                send(ws, "phase_start", { phase: nodeName });
                send(ws, "phase_status", { text: NODE_LABELS[nodeName] });
              }
              break;
            }

            // ===== 节点结束：解析节点输出并发送摘要信息给前端 =====
            case "on_chain_end": {
              const nodeName = event.name;
              const output = event.data?.output as Record<string, unknown> | undefined;

              // Orchestrator 分析完成 → 发送意图分析和 Agent 委派结果
              if (nodeName === "orchestrator" && output?.analysis) {
                try {
                  const analysis = JSON.parse(output.analysis as string);
                  send(ws, "content", { content: `分析完成：${analysis.intent || "未知"}，委派 ${analysis.agentPlan?.length || 0} 个 Agent。` });
                } catch (e) { console.warn("[AgentWS] orchestrator JSON 解析失败:", (e as Error).message); }
              }

              // DocAnalyst 文档分析完成 → 发送结构分析结果
              if (nodeName === "doc_analyst" && output?.documentMaps) {
                try {
                  const maps = JSON.parse(output.documentMaps as string);
                  if (maps.length > 0 && maps[0].tables?.length > 0) {
                    const labels = maps[0].tables.flatMap((t: Record<string, unknown>) => (t.labels as unknown[]) || []);
                    send(ws, "content", { content: `文档结构分析完成，发现 ${maps[0].tables[0]?.cells?.length || 0} 个单元格，${labels.length} 个标签字段。` });
                  }
                } catch (e) { console.warn("[AgentWS] doc_analyst documentMaps 解析失败:", (e as Error).message); }
              }

              // TemplateFiller 填充完成 → 发送每个字段的写入/拦截结果
              // 原因：TemplateFiller 是纯确定性节点，不产生 LangGraph tool 事件，
              // 因此需要在此手动生成 tool_start/tool_result 事件让前端展示操作日志
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

              // Reviewer 验证完成 → 发送 Diff 报告摘要和最终结果
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

              // SurgicalEditor 节点通过 output.success 字段发送边缘情况摘要
              if (output?.success !== undefined && output?.lastAgent === "SurgicalEditor") {
                send(ws, "content", { content: output.success ? "✅ 编辑完成" : "⚠️ 编辑完成，部分操作可能未成功" });
                send(ws, "summary", {
                  result: output.success ? "success" : "partial",
                  summary_text: output.success ? "✅ 编辑完成" : "⚠️ 编辑完成",
                  detail: "",
                  failed_tasks: [],
                });
              }

              // 每个节点结束时都发送 phase_end
              if (nodeName) send(ws, "phase_end", { phase: nodeName });
              break;
            }

            // ===== 工具开始（仅用于 surgical_editor 节点的 Tool Calling）=====
            // 从工具元数据中获取展示信息，只有 showInUI=true 的工具才发送给前端
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

            // ===== 工具结束：发送工具执行结果给前端 =====
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

            // ===== 自定义事件：转发 writer 发射的事件（兼容占位）=====
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
        // 判断是否为用户主动取消（AbortController.abort() 触发）
        if (e.name === "AbortError") {
          send(ws, "content", { content: "操作已取消。" });
        } else {
          // 其他异常 → 发送 error 和 failed summary 给前端
          send(ws, "error", { message: e.message || "Agent 执行失败" });
          send(ws, "summary", { result: "failed", summary_text: "❌ 执行出错", detail: e.message, failed_tasks: [] });
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
// 辅助函数
// ================================================================

/**
 * 向 WebSocket 客户端发送 JSON 消息
 * 先检查连接状态是否为 OPEN，避免向断开的连接发送消息导致异常
 * @param ws   目标 WebSocket 连接
 * @param type 消息类型（会编码为 { type, data } JSON）
 * @param data 消息负载
 */
function send(ws: WebSocket, type: string, data?: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

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
    const stream = agent.streamProcess({ message: data.message || "", contextDocId: data.docId, mode: "chat" });
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
 * SSE 格式为 `event: type\ndata: json\n\n`，eventsource-parser 能正确解析多行 data、
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
