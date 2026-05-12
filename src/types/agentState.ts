// Agent 状态类型定义 — 定义 AI Agent 工作流中各阶段的状态和通信结构
// 工作流：用户请求 → 分析（Analysis）→ 规划（Plan）→ 执行（Execute）→ 验证（Validate）
// 每个阶段都有对应的 thought 字段用于记录 LLM 推理过程

// AgentState — Agent 一次任务执行的完整状态快照
// 包含从分析到下结论的全流程数据，用于跨请求状态传递和恢复
export interface AgentState {
  user_input: string;                           // 用户的原始输入文本
  doc_path: string;                             // 当前操作的文档路径
  retry_count: number;                          // 重试次数（用于容错和控制循环上限）
  related_memory: string;                       // 相关历史记忆（上下文增强）
  analysis: AnalysisResult | Record<string, unknown>;  // 分析阶段的结果
  analysis_thought: string;                     // 分析阶段的 LLM 思考过程
  plan: ExecutionPlan | Record<string, unknown>;  // 执行计划
  plan_thought: string;                         // 规划阶段的 LLM 思考过程
  execution_log: string;                        // 执行日志（记录每步操作）
  execution_thought: string;                    // 执行阶段的 LLM 思考过程
  result: string;                               // 最终结果（返回给用户）
  validate_thought: string;                     // 验证阶段的 LLM 思考过程
}

// AnalysisResult — 分析阶段输出：识别用户意图（动作 + 目标 + 详情）
export interface AnalysisResult {
  action: string;
  target: string;
  details: string;
}

// ExecutionPlan — 执行计划：包含多个有序步骤
export interface ExecutionPlan {
  steps: ExecutionStep[];
}

// ExecutionStep — 单个执行步骤：动作名 + 参数键值对
export interface ExecutionStep {
  action: string;
  params: Record<string, unknown>;
}

// AgentRequest — 前端/用户发起的 Agent 请求
// doc_path 和 doc_id 二选一，mode 控制单文档/多文档模式
export interface AgentRequest {
  user_input: string;
  doc_path: string;
  doc_id?: string;
  mode?: "single" | "multi";
  model_config?: ModelConfig;
}

// ModelConfig — LLM 模型配置，允许动态切换模型或调整温度参数
export interface ModelConfig {
  model?: string;
  analyzer_model?: string;   // 分析阶段使用的模型
  planner_model?: string;    // 规划阶段使用的模型
  validator_model?: string;  // 验证阶段使用的模型
  temperature?: number;      // LLM 生成随机度（0-2）
}

// AgentResponse — Agent 执行完成后的响应结构
export interface AgentResponse {
  analysis: string;
  plan: string;
  execution_log: string;
  result: string;
}