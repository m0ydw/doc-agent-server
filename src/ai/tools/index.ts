/**
 * AI Tools 统一导出
 *
 * 所有 LangChain StructuredTool 从这里导出，
 * 工作流节点和外部模块只需 import 这个文件。
 */

export { AnalyzeTool } from "./analyzeTool";
export type { AnalyzeOutput } from "./analyzeTool";

export { PlanTool } from "./planTool";
export type { PlanOutput, PlanTask } from "./planTool";

export { ExecuteTool } from "./executeTool";
export type { ExecuteResult } from "./executeTool";
export { parseExecuteResult, extractDocSnippet } from "./executeTool";

export { ValidateTool } from "./validateTool";
export type { ValidateOutput } from "./validateTool";

// SDK 工具 + metadata（改进项 4, 7）
export {
  SDKFindTextTool,
  SDKReplaceTextTool,
  SDKReplaceAllTool,
  SDKGetTextTool,
  SDKSaveTool,
  getToolMetadata,
  SDK_TOOL_METADATA,
} from "./sdkTools";
export type { SDKToolMetadata } from "./sdkTools";
