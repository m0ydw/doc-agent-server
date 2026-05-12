/**
 * AI Tools 统一导出 — SDK 工具集 + Output Schemas
 *
 * 【工具分类】
 * - SDK 工具（sdkTools/*.ts）: 封装 SuperDoc SDK 的文档操作
 *   - 只读工具: findText, getText, findCell, readTable, getStructure
 *   - 写入工具: setText, replaceText, replaceAll, applyFormat
 *   - 控制工具: taskComplete（标记完成）
 * - Output Schemas（outputSchemas.ts）: 结构化输出工具，用于旧版 Agent 的
 *   analyze/plan/validate 阶段引导 LLM 以 tool_call 输出 JSON
 *
 * 【在多Agent架构中的使用】
 * 各 Agent 节点按需引入特定工具：
 *   - DocAnalyst → findCell, readTable, getStructure
 *   - SurgicalEditor → findText, replaceText, replaceAll, applyFormat, taskComplete
 *   - TemplateFiller → setText（通过 editor 服务调用，不经过工具类）
 *   - Reviewer → getText, readTable, findCell
 *
 * 【工具元数据】
 * getToolMetadata / getToolMetadataByName: 返回工具的展示信息（displayName、
 * showInUI、argsFormatter），供 wsAgentHandler 生成前端 tool_start/tool_result 事件。
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
