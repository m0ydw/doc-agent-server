/**
 * SDK 工具共享类型
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
