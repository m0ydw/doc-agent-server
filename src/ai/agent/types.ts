/**
 * ================================================================
 * GlobalAgent 阶段输出类型定义
 * ================================================================
 *
 * 【用途】
 *   替换散落在多处的 Record<string, any>，提供类型安全的阶段输出。
 *   与 outputSchemas.ts 中的 Zod Schema 对应，但专注于消费侧的类型。
 *
 * 【原则】
 *   - 所有阶段输出都有明确的 TypeScript interface
 *   - 使用 discriminated union 让 phaseRunner 能类型安全地分发
 */

import type { StructuredTool } from "@langchain/core/tools";
import type { BaseMessage } from "@langchain/core/messages";

// ================================================================
// 1. Analyze 阶段输出
// ================================================================

/** 单个操作意图 */
export interface AnalysisOperation {
  type: "query" | "replace" | "format" | "insert" | "delete" | "save";
  target: string;
  goal: string;
  details?: string;
}

/** Analyze 阶段结构化结果（与 AnalysisOutputSchema 对应） */
export interface AnalysisResult {
  intent: "content_query" | "text_replace" | "format_change" | "mixed" | "other";
  operations: AnalysisOperation[];
  context_hints?: string[];
  target_doc?: string;
}

// ================================================================
// 2. Plan 阶段输出
// ================================================================

/** 单个任务 */
export interface PlanTask {
  id: string;
  goal: string;
  description: string;
  constraints?: string[];
  success_criteria?: string;
  priority?: "high" | "medium" | "low";
}

/** 任务依赖 */
export interface TaskDependency {
  from: string;
  to: string;
  reason?: string;
}

/** 备选策略 */
export interface FallbackStrategy {
  condition: string;
  action: string;
}

/** Plan 阶段结构化结果（与 PlanOutputSchema 对应） */
export interface PlanResult {
  tasks: PlanTask[];
  dependencies?: TaskDependency[];
  ordering?: "sequential" | "parallel";
  fallback_strategies?: FallbackStrategy[];
}

// ================================================================
// 3. Validate 阶段输出
// ================================================================

/** Validate 阶段结构化结果（与 ValidateOutputSchema 对应） */
export interface ValidateResult {
  result: "成功" | "失败" | "部分成功";
  summary: string;
  retryable: boolean;
  needs_user_input: boolean;
  failed_tasks?: string[];
  error_analysis?: string;
}

// ================================================================
// 4. 联合类型（类型安全的阶段输出分发）
// ================================================================

export type PhaseName = "analyze" | "plan" | "validate";

/** 阶段输出联合类型 */
export type PhaseOutput = AnalysisResult | PlanResult | ValidateResult;

/**
 * 根据阶段名推断输出类型
 * 用法: const result = raw as PhaseOutputMap["analyze"];
 */
export interface PhaseOutputMap {
  analyze: AnalysisResult;
  plan: PlanResult;
  validate: ValidateResult;
}

// ================================================================
// 5. 阶段执行器配置（供 phaseRunner 使用）
// ================================================================

/**
 * 通用阶段执行配置
 * @template T — 该阶段的输出类型
 */
export interface PhaseConfig<T extends PhaseOutput = PhaseOutput> {
  /** 阶段名称标识 */
  phaseName: PhaseName;
  /** 构建 prompt 的工厂函数（一次调用返回 thoughtMessages + toolContext） */
  promptBuilder: () => Promise<{
    thoughtMessages: BaseMessage[];
    toolSystemMessage: string;
    toolContext: string;
  }>;
  /** 该阶段的输出工具实例（如 AnalysisOutputTool） */
  outputTool: StructuredTool;
  /** 从 JSON 对象生成用户友好的阶段摘要文本 */
  summaryBuilder: (obj: T) => string;
  /** JSON 工具调用失败时的回退默认 JSON 字符串 */
  fallbackJson: string;
}

// ================================================================
// 6. 流式策略类型（供 phaseStrategy 使用）
// ================================================================

/**
 * 流式策略结果包装
 * - events: 所有 [thought] 流式事件
 * - structuredData: 结构化 JSON 数据（可能为 null）
 */
export interface PhaseStreamResult {
  events: string;
  structuredData: Record<string, unknown> | null;
}
