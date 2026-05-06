/**
 * ================================================================
 * SSE 事件标准化（改进项 #5, #11, #12）
 * ================================================================
 *
 * 【替代原来的 `[prefix]content\n` 自定义行协议】
 *
 * 标准格式：`event: <type>\ndata: <json_payload>\n\n`
 *
 * 用法：
 *   yield sse("thought", { content: "..." });
 *   yield sse("phase_start", { phase: "analyze" });
 *   yield sse("error", { message: "Agent 未初始化" });
 */

// ================================================================
// 1. 事件类型定义
// ================================================================

export type SseEventType =
  | "thought"
  | "content"
  | "chat"
  | "phase_start"
  | "phase_end"
  | "phase_status"
  | "doc_target"
  | "tool_start"
  | "tool_result"
  | "summary"
  | "error"
  | "warning"
  | "todo_list"
  | "todo_done";

// ================================================================
// 2. 主力发射器
// ================================================================

/**
 * 生成标准 SSE 帧
 * @returns `"event: type\ndata: {json}\n\n"`
 */
export function sse(type: SseEventType, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 快捷方式：生成 SSE 帧并 append "\n"（保持与旧 yield 格式的兼容）
 * @deprecated 使用 sse() 即可，SSE 标准不需要额外换行
 */
export function sseLine(type: SseEventType, data: unknown): string {
  return sse(type, data);
}

// ================================================================
// 3. 语义化快捷方式（提高可读性）
// ================================================================

export const ssePhaseStart = (phase: string) => sse("phase_start", { phase });
export const ssePhaseEnd = (phase: string) => sse("phase_end", { phase });
export const ssePhaseStatus = (text: string) => sse("phase_status", { text });
export const sseThought = (content: string) => sse("thought", { content });
export const sseContent = (content: string) => sse("content", { content });
export const sseChat = (content: string) => sse("chat", { content });
export const sseDocTarget = (fileName: string) => sse("doc_target", { fileName });
export const sseToolStart = (tool: string, args: string) => sse("tool_start", { tool, args });
export const sseToolResult = (success: boolean, tool: string, result: string) =>
  sse("tool_result", { success, tool, result });
export const sseSummary = (data: Record<string, unknown>) => sse("summary", data);
export const sseError = (message: string) => sse("error", { message });
export const sseWarning = (message: string) => sse("warning", { message });
export const sseTodoList = (tasks: Array<{ id: string; goal: string }>) => sse("todo_list", { tasks });
export const sseTodoDone = (id: string) => sse("todo_done", { id });
