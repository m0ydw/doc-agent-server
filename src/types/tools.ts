/**
 * 工具相关类型定义
 */

// 执行操作类型
export type ExecuteAction =
  | "set_bold"
  | "set_color"
  | "set_font"
  | "set_font_size"
  | "set_alignment"
  | "replace_text"
  | "insert_text"
  | "delete_text"
  | "save";

export interface ExecuteParams {
  // 基础参数
  text?: string;
  oldText?: string;
  newText?: string;

  // 格式参数
  color?: string;
  font?: string;
  fontSize?: number;
  alignment?: "left" | "center" | "right" | "justify";
  position?: "before" | "after" | "replace";
}

export interface ExecuteResult {
  status: "成功" | "失败";
  message: string;
  details?: Record<string, unknown>;
}

// 工具执行结果
export interface ToolResult {
  thought: string;
  [key: string]: unknown;
}

// 分析结果
export interface AnalyzeResult extends ToolResult {
  analysis: AnalysisResultData;
}

export interface AnalysisResultData {
  action: string;
  target: string;
  details: string;
}

// 计划结果
export interface PlanResult extends ToolResult {
  plan: PlanData;
}

export interface PlanData {
  steps: ExecuteStepData[];
}

export interface ExecuteStepData {
  action: ExecuteAction;
  params: ExecuteParams;
}

// 验证结果
export interface ValidateResult extends ToolResult {
  result: string;
}