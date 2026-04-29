/**
 * ================================================================
 * Output Schemas — tool calling 用的 Zod Schema 定义
 * ================================================================
 *
 * 【用途】
 * 配合 streamPhaseWithSeparation，让 LLM 通过 bindTools 输出结构化数据，
 * 替代原来不可靠的 JSON mode。
 *
 * 【原理】
 * 每个阶段创建一个"输出工具"(StructuredTool)，其 schema 定义了期望的输出结构。
 * LLM 被引导调用该工具，工具的参数即为期望的结构化数据。
 * 工具本身不执行任何实际操作(func 返回参数本身)，
 * 我们只取 tool_calls[0].args 作为结果。
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// ================================================================
// 1. Analyze 阶段输出 Schema
// ================================================================

export const AnalysisOutputSchema = z.object({
  /** 用户需求的总体意图分类 */
  intent: z.enum(["text_replace", "format_change", "mixed", "other"])
    .describe("用户需求的意图类型：text_replace=文本替换, format_change=格式修改, mixed=混合操作, other=其他"),
  /** 识别出的所有操作意图 */
  operations: z.array(z.object({
    type: z.enum(["replace", "format", "insert", "delete", "save"])
      .describe("操作类型"),
    target: z.string().describe("操作目标描述，如'公司'、'标题'"),
    goal: z.string().describe("用户想要达成的效果，如'替换为集团'、'加粗'"),
    details: z.string().optional().describe("补充说明，如'全文替换'、'只改第一处'"),
  })).describe("需要执行的操作列表，至少包含一个操作"),
  /** 上下文提示 */
  context_hints: z.array(z.string()).optional()
    .describe("对当前需求的语境说明，如'公司可能指有限公司'"),
  /** 目标文档名 */
  target_doc: z.string().optional()
    .describe("用户明确指定的目标文档名"),
});

/**
 * 创建 Analyze 输出工具
 * LLM 调用此工具输出分析结果，工具不做实事，只捕获参数
 */
export class AnalysisOutputTool extends StructuredTool {
  name = "output_analysis";
  description = "输出文档需求分析结果。调用此工具来提交分析。";
  schema = AnalysisOutputSchema;

  async _call(input: z.infer<typeof AnalysisOutputSchema>): Promise<string> {
    return JSON.stringify(input);
  }
}

// ================================================================
// 2. Plan 阶段输出 Schema
// ================================================================

export const PlanOutputSchema = z.object({
  /** 任务清单 */
  tasks: z.array(z.object({
    id: z.string().describe("任务唯一ID，如'task-1'"),
    goal: z.string().describe("任务的一句话目标，如'将全文公司替换为集团'"),
    description: z.string().describe("详细描述要完成的任务"),
    constraints: z.array(z.string()).optional()
      .describe("执行约束，如'全文档范围内替换'、'不替换作为词组一部分的文字'"),
    success_criteria: z.string().optional()
      .describe("任务成功的判断标准"),
    priority: z.enum(["high", "medium", "low"]).optional()
      .describe("任务优先级"),
  })).describe("需要执行的任务列表，至少一个任务"),
  /** 任务依赖关系 */
  dependencies: z.array(z.object({
    from: z.string().describe("前置任务ID"),
    to: z.string().describe("后置任务ID"),
    reason: z.string().optional().describe("依赖原因"),
  })).optional().describe("任务之间的依赖关系"),
  /** 执行顺序 */
  ordering: z.enum(["sequential", "parallel"]).optional()
    .describe("任务执行顺序：sequential=顺序执行, parallel=可并行"),
  /** 备选策略 */
  fallback_strategies: z.array(z.object({
    condition: z.string().describe("触发备选方案的条件"),
    action: z.string().describe("备选方案描述"),
  })).optional().describe("失败时的备选策略"),
});

/**
 * 创建 Plan 输出工具
 */
export class PlanOutputTool extends StructuredTool {
  name = "output_plan";
  description = "输出文档处理任务计划。调用此工具来提交任务清单。";
  schema = PlanOutputSchema;

  async _call(input: z.infer<typeof PlanOutputSchema>): Promise<string> {
    return JSON.stringify(input);
  }
}

// ================================================================
// 3. Validate 阶段输出 Schema
// ================================================================

export const ValidateOutputSchema = z.object({
  /** 验证结果 */
  result: z.enum(["成功", "失败", "部分成功"])
    .describe("操作结果：成功=全部完成, 失败=关键任务全部失败, 部分成功=部分完成"),
  /** 总结 */
  summary: z.string().describe("简要总结验证结果"),
  /** 是否可重试 */
  retryable: z.boolean()
    .describe("是否可以重试：true=临时性错误可重试, false=根本性错误不可重试"),
  /** 是否需要用户输入 */
  needs_user_input: z.boolean()
    .describe("是否需要用户提供更多信息或确认"),
  /** 失败任务列表 */
  failed_tasks: z.array(z.string()).optional()
    .describe("失败的任务ID或描述"),
  /** 错误分析 */
  error_analysis: z.string().optional()
    .describe("失败原因分析"),
});

/**
 * 创建 Validate 输出工具
 */
export class ValidateOutputTool extends StructuredTool {
  name = "output_validate";
  description = "输出文档操作验证结果。调用此工具来提交验证结论。";
  schema = ValidateOutputSchema;

  async _call(input: z.infer<typeof ValidateOutputSchema>): Promise<string> {
    return JSON.stringify(input);
  }
}
