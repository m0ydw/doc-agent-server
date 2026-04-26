/**
 * Agent 状态类型定义
 */

export interface AgentState {
  /** 用户输入 */
  user_input: string;
  /** 文档路径 */
  doc_path: string;
  /** 重试次数 */
  retry_count: number;
  /** 相关记忆 */
  related_memory: string;
  /** 分析结果 */
  analysis: AnalysisResult | Record<string, unknown>;
  /** 分析思考 */
  analysis_thought: string;
  /** 执行计划 */
  plan: ExecutionPlan | Record<string, unknown>;
  /** 执行思考 */
  plan_thought: string;
  /** 执行日志 */
  execution_log: string;
  /** 执行思考 */
  execution_thought: string;
  /** 验证结果 */
  result: string;
  /** 验证思考 */
  validate_thought: string;
}

export interface AnalysisResult {
  action: string;
  target: string;
  details: string;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
}

export interface ExecutionStep {
  action: string;
  params: Record<string, unknown>;
}

export interface AgentRequest {
  user_input: string;
  doc_path: string;
  doc_id?: string;
  mode?: "single" | "multi";
  model_config?: ModelConfig;
}

export interface ModelConfig {
  model?: string;
  analyzer_model?: string;
  planner_model?: string;
  validator_model?: string;
  temperature?: number;
}

export interface AgentResponse {
  analysis: string;
  plan: string;
  execution_log: string;
  result: string;
}