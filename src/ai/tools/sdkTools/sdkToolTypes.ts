/**
 * SDK 工具共享类型 — 每个工具类都附加一个 static metadata 字段
 *
 * 【metadata 的用途】
 * wsAgentHandler 在收到 LangGraph 流式事件中的 tool_start / tool_end 时，
 * 通过 tool name 查找对应的 metadata，将工具参数和结果格式化为前端友好的中文描述。
 *
 * 【metadata 字段说明】
 * - displayName: 前端 UI 展示的工具名称（中文）
 * - argsFormatter: 将 JSON 参数转为中文描述文本（如在"查找"工具中，将 {text: "公司"}
 *   格式化为 "查找文本 \"公司\"")
 * - showInUI: 是否在操作日志中展示此工具（task_complete 等内部工具不展示）
 */

import type { StructuredTool } from "@langchain/core/tools";

export interface SDKToolMetadata {
  /** 前端展示的中文名 */
  displayName: string;
  /** 将工具调用参数格式化为中文描述 */
  argsFormatter: (args: Record<string, unknown>) => string;
  /** 是否在 UI 中展示该工具调用 */
  showInUI: boolean;
}

/** 从工具实例获取其 metadata */
export function getToolMetadata(tool: StructuredTool): SDKToolMetadata {
  const ctor = tool.constructor as typeof StructuredTool & { metadata?: SDKToolMetadata };
  if (ctor.metadata) return ctor.metadata;
  return { displayName: tool.name, argsFormatter: () => "", showInUI: true };
}
