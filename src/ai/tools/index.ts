/**
 * AI Tools 统一导出
 *
 * SDK 工具集 + metadata 从这里导出。
 * 多 Agent 架构中，各 Agent 节点按需引入特定工具。
 */

// SDK 工具 + metadata
export {
  SDKFindTextTool,
  SDKReplaceTextTool,
  SDKReplaceAllTool,
  SDKGetTextTool,
  SDKTaskCompleteTool,
  SDKSetTextTool,
  SDKApplyFormatTool,
  SDKGetStructureTool,
  SDKFindCellTool,
  SDKReadTableTool,
  getToolMetadata,
  SDK_TOOL_METADATA,
  getToolMetadataByName,
} from "./sdkTools";
export type { SDKToolMetadata } from "./sdkTools";

// Output Schemas（结构化的工具输出定义）
export {
  AnalysisOutputTool,
  AnalysisOutputSchema,
  PlanOutputTool,
  PlanOutputSchema,
  ValidateOutputTool,
  ValidateOutputSchema,
} from "./outputSchemas";
