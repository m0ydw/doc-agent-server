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
export { SDKFindCellTool } from "./sdkFindCellTool";
export { SDKReadTableTool } from "./sdkReadTableTool";

import { SDKFindTextTool } from "./sdkFindTextTool";
import { SDKReplaceTextTool } from "./sdkReplaceTextTool";
import { SDKReplaceAllTool } from "./sdkReplaceAllTool";
import { SDKGetTextTool } from "./sdkGetTextTool";
import { SDKTaskCompleteTool } from "./sdkTaskCompleteTool";
import { SDKSetTextTool } from "./sdkSetTextTool";
import { SDKApplyFormatTool } from "./sdkApplyFormatTool";
import { SDKGetStructureTool } from "./sdkGetStructureTool";
import { SDKFindCellTool } from "./sdkFindCellTool";
import { SDKReadTableTool } from "./sdkReadTableTool";
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
  [new SDKFindCellTool("").name]:      SDKFindCellTool.metadata,
  [new SDKReadTableTool("").name]:     SDKReadTableTool.metadata,
};

/** 根据工具名获取 metadata（精确匹配 + 模糊匹配兜底） */
export function getToolMetadataByName(toolName: string): SDKToolMetadata {
  const meta = SDK_TOOL_METADATA[toolName];
  if (meta) return meta;
  // 模糊匹配：仅对 sdk_ 前缀的工具名去下划线比较
  const norm = (s: string) => s.toLowerCase().replace(/_/g, "");
  for (const key of Object.keys(SDK_TOOL_METADATA)) {
    if (key.startsWith("sdk_") && (norm(toolName).includes(norm(key)) || norm(key).includes(norm(toolName)))) {
      return SDK_TOOL_METADATA[key];
    }
  }
  console.warn("[sdkTools] 未注册: " + toolName);
  return { displayName: toolName, argsFormatter: () => "", showInUI: true };
}
