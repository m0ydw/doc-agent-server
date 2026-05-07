/**
 * SDK 工具集 — 统一导出
 */

export type { SDKToolMetadata } from "./sdkToolTypes";
export { getToolMetadata } from "./sdkToolTypes";

export { SDKFindTextTool } from "./sdkFindTextTool";
export { SDKReplaceTextTool } from "./sdkReplaceTextTool";
export { SDKReplaceAllTool } from "./sdkReplaceAllTool";
export { SDKGetTextTool } from "./sdkGetTextTool";
export { SDKTaskCompleteTool } from "./sdkTaskCompleteTool";
export { SDKSetTextTool } from "./sdkSetTextTool";
export { SDKApplyFormatTool } from "./sdkApplyFormatTool";
export { SDKGetStructureTool } from "./sdkGetStructureTool";

import { SDKFindTextTool } from "./sdkFindTextTool";
import { SDKReplaceTextTool } from "./sdkReplaceTextTool";
import { SDKReplaceAllTool } from "./sdkReplaceAllTool";
import { SDKGetTextTool } from "./sdkGetTextTool";
import { SDKTaskCompleteTool } from "./sdkTaskCompleteTool";
import { SDKSetTextTool } from "./sdkSetTextTool";
import { SDKApplyFormatTool } from "./sdkApplyFormatTool";
import { SDKGetStructureTool } from "./sdkGetStructureTool";
import type { SDKToolMetadata } from "./sdkToolTypes";

/** 统一 metadata 映射表 */
export const SDK_TOOL_METADATA: Record<string, SDKToolMetadata> = {
  [new SDKFindTextTool("").name]:      SDKFindTextTool.metadata,
  [new SDKReplaceTextTool("").name]:   SDKReplaceTextTool.metadata,
  [new SDKReplaceAllTool("").name]:    SDKReplaceAllTool.metadata,
  [new SDKGetTextTool("").name]:       SDKGetTextTool.metadata,
  [new SDKTaskCompleteTool().name]:    SDKTaskCompleteTool.metadata,
  [new SDKSetTextTool("").name]:       SDKSetTextTool.metadata,
  [new SDKApplyFormatTool("").name]:   SDKApplyFormatTool.metadata,
  [new SDKGetStructureTool("").name]:  SDKGetStructureTool.metadata,
};

/** 根据工具名获取 metadata（精确匹配 + 模糊匹配兜底） */
export function getToolMetadataByName(toolName: string): SDKToolMetadata {
  const meta = SDK_TOOL_METADATA[toolName];
  if (meta) return meta;
  for (const key of Object.keys(SDK_TOOL_METADATA)) {
    if (toolName.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(toolName.toLowerCase())) {
      return SDK_TOOL_METADATA[key];
    }
  }
  console.warn("[sdkTools] 未注册: " + toolName);
  return { displayName: toolName, argsFormatter: () => "", showInUI: true };
}
