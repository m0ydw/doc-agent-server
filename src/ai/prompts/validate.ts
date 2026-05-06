/**
 * ================================================================
 * Validate 阶段 Prompt 模板
 * ================================================================
 *
 * 【改进项 7 - 提示词管理集中化】
 *   新增 buildValidatePhase 工厂函数，一次性返回
 *   { thoughtMessages, toolSystemMessage, toolContext }。
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * 思考阶段：流式输出 thought，评估执行结果
 */
export const validateThoughtPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是操作验证专家。根据执行日志判断任务是否成功。

【输出规则】
{anti_leak_rules}`],
  ["human", `## 执行日志
{execution_log}

## 原始任务清单
{plan_tasks}`],
]);

/**
 * 工具调用阶段：引导 LLM 调用 output_validate 工具
 */
export const validateToolPrompt = ChatPromptTemplate.fromMessages([
  ["system", `基于以上分析，调用 output_validate 工具输出验证结果。不要输出文字，只调用工具。`],
  ["human", `{validate_context}`],
]);

// ================================================================
// 工厂函数（改进项 7）
// ================================================================

/** buildValidatePhase 的参数 */
export interface ValidatePhaseParams {
  /** 防泄露规则（来自 prompts/shared/rules） */
  anti_leak_rules: string;
  /** Execute 阶段的执行日志 */
  execution_log: string;
  /** Plan 阶段的 JSON 结果（cleanPlan） */
  plan_tasks: string;
}

/**
 * 构建 Validate 阶段所需的 prompt 组件
 *
 * 替代原来散落在 globalAgent.ts 中的三行调用。
 */
export async function buildValidatePhase(
  params: ValidatePhaseParams
): Promise<{
  thoughtMessages: BaseMessage[];
  toolSystemMessage: string;
  toolContext: string;
}> {
  const { anti_leak_rules, execution_log, plan_tasks } = params;

  // 构建 tool 阶段的上下文
  const toolContext = `## 执行日志\n${execution_log}\n\n## 原始任务\n${plan_tasks}`;

  // 构建 thought 消息列表
  const thoughtMessages = await validateThoughtPrompt.formatMessages({
    anti_leak_rules,
    execution_log,
    plan_tasks,
  });

  // 构建 tool system message
  const toolMsgs = await validateToolPrompt.formatMessages({
    validate_context: toolContext,
  });
  const toolSystemMessage = toolMsgs[0].content as string;

  return { thoughtMessages, toolSystemMessage, toolContext };
}
