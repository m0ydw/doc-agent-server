/**
 * ================================================================
 * SSE 事件标准化发射器（改进项 #5, #11, #12）
 * ================================================================
 *
 * 【替代原来的 `[prefix]content\n` 自定义行协议】
 *
 * 标准格式：`event: <type>\ndata: <json_payload>\n\n`
 *
 * 用法示例：
 *   yield sse("thought", { content: "..." });
 *   yield sse("phase_start", { phase: "analyze" });
 *   yield sse("error", { message: "Agent 未初始化" });
 *
 * 【在 Agent 流程中的调用时机】
 * - thought / content: LLM 每次产生新 token 时（逐 token 流式推送）
 * - phase_start / phase_end: 每个工作流节点开始/结束时
 * - phase_status: 节点状态文本显示（如"正在分析任务..."）
 * - doc_target: 确定操作的目标文档时
 * - tool_start / tool_result: Agent 调用 SDK 工具前后
 * - summary: 任务完成后发送总结报告
 * - error / warning: 错误或警告发生时
 * - todo_list / todo_done: 任务清单更新时
 * ================================================================
 */

// ================================================================
// 1. 事件类型定义 — 所有 SSE 事件类型的联合类型
// 前端根据 event 字段决定如何展示和路由
// ================================================================

export type SseEventType =
  /** LLM 思考过程（非最终输出） */
  | "thought"
  /** LLM 最终输出内容 */
  | "content"
  /** Chat 模式对话内容（区别于 workflow 模式的 content） */
  | "chat_content"
  /** 工作流节点开始 */
  | "phase_start"
  /** 工作流节点结束 */
  | "phase_end"
  /** 工作流节点状态文本（如"正在分析任务..."） */
  | "phase_status"
  /** 当前操作的目标文档 */
  | "doc_target"
  /** 工具调用开始 */
  | "tool_start"
  /** 工具调用结果 */
  | "tool_result"
  /** 任务完成后的总结报告 */
  | "summary"
  /** 错误消息 */
  | "error"
  /** 警告消息（非致命） */
  | "warning"
  /** 任务清单列表 */
  | "todo_list"
  /** 单个任务完成 */
  | "todo_done";

// ================================================================
// 2. 主力发射器 — 底层函数，所有语义化快捷方式都基于此构建
// ================================================================

/**
 * 生成标准 SSE 帧字符串
 *
 * SSE 协议要求每行以 "field: value" 格式，事件间以空行分隔。
 * 前端 EventSource API 和 eventsource-parser 都按此格式解析。
 *
 * @param type 事件类型（编码为 `event:` 字段）
 * @param data 事件负载（编码为 `data:` 字段，JSON 序列化）
 * @returns 标准 SSE 帧字符串 `"event: type\ndata: {json}\n\n"`
 */
export function sse(type: SseEventType, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ================================================================
// 3. 语义化快捷方式 — 提高代码可读性，降低拼写错误风险
//
// 每个快捷方式对应一个具体的业务语义，底层调用 sse() 函数。
// 例如：
//   sseThought("...") 等价于 sse("thought", { content: "..." })
//   sseToolStart("...", "...") 等价于 sse("tool_start", { tool: "...", args: "..." })
// ================================================================

/** 发射阶段开始事件 */
export const ssePhaseStart = (phase: string) => sse("phase_start", { phase });
/** 发射阶段结束事件 */
export const ssePhaseEnd = (phase: string) => sse("phase_end", { phase });
/** 发射阶段状态文本（纯展示用） */
export const ssePhaseStatus = (text: string) => sse("phase_status", { text });
/** 发射 LLM 思考过程 token */
export const sseThought = (content: string) => sse("thought", { content });
/** 发射 LLM 输出内容 token */
export const sseContent = (content: string) => sse("content", { content });
/** 发射 Chat 模式对话内容 token */
export const sseChat = (content: string) => sse("chat_content", { content });
/** 发射当前操作的目标文档信息 */
export const sseDocTarget = (fileName: string) =>
  sse("doc_target", { fileName });
/** 发射工具调用开始（工具名 + 参数） */
export const sseToolStart = (tool: string, args: string) =>
  sse("tool_start", { tool, args });
/** 发射工具调用结果（成功/失败 + 输出） */
export const sseToolResult = (success: boolean, tool: string, result: string) =>
  sse("tool_result", { success, tool, result });
/** 发射任务总结报告 */
export const sseSummary = (data: Record<string, unknown>) =>
  sse("summary", data);
/** 发射错误消息 */
export const sseError = (message: string) => sse("error", { message });
/** 发射警告消息（非致命错误） */
export const sseWarning = (message: string) => sse("warning", { message });
/** 发射任务清单列表 */
export const sseTodoList = (tasks: Array<{ id: string; goal: string }>) =>
  sse("todo_list", { tasks });
/** 发射单个任务完成通知 */
export const sseTodoDone = (id: string) => sse("todo_done", { id });
