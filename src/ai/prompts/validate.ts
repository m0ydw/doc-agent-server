/**
 * ================================================================
 * Validate 阶段 Prompt 模板
 * ================================================================
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";

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
