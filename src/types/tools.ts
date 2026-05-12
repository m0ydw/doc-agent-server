// 工具相关类型定义 — 定义 Agent 工具链中执行操作、参数、结果的数据结构
// 这些类型用于 AI Agent 的 plan → execute → validate 流程

// ExecuteAction — Agent 可执行的文档操作类型
// 涵盖格式设置（set_bold/set_color/set_font/set_font_size/set_alignment）
// 和文本编辑（replace_text/insert_text/delete_text）以及 save
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

// ExecuteParams — 执行操作的参数定义
// 基础参数：text（操作文本）、oldText/newText（替换/插入用）
// 格式参数：color、font、fontSize、alignment（格式设置用）
// position：插入位置（before/after/replace）
export interface ExecuteParams {
  text?: string;
  oldText?: string;
  newText?: string;
  color?: string;
  font?: string;
  fontSize?: number;
  alignment?: "left" | "center" | "right" | "justify";
  position?: "before" | "after" | "replace";
}

// ExecuteResult — 单次操作执行结果
export interface ExecuteResult {
  status: "成功" | "失败";
  message: string;
  details?: Record<string, unknown>;
}

// ToolResult — 工具执行的通用返回结构（包含 thought 字段用于 LLM 推理链）
export interface ToolResult {
  thought: string;
  [key: string]: unknown;
}

// AnalyzeResult — 分析工具的结果
export interface AnalyzeResult extends ToolResult {
  analysis: AnalysisResultData;
}

export interface AnalysisResultData {
  action: string;
  target: string;
  details: string;
}

// PlanResult — 计划工具的结果，包含多个执行步骤
export interface PlanResult extends ToolResult {
  plan: PlanData;
}

export interface PlanData {
  steps: ExecuteStepData[];
}

// ExecuteStepData — 单个执行步骤（动作 + 参数）
export interface ExecuteStepData {
  action: ExecuteAction;
  params: ExecuteParams;
}

// ValidateResult — 验证工具的结果
export interface ValidateResult extends ToolResult {
  result: string;
}