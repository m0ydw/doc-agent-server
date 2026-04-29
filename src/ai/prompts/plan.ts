/**
 * ================================================================
 * Plan 阶段 Prompt 模板
 * ================================================================
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";

/**
 * 思考阶段：流式输出 thought，制定任务计划
 */
export const planThoughtPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是任务规划专家。根据分析结果制定任务清单。

【输出规则】
{anti_leak_rules}`],
  ["human", `## 分析结果
{clean_analysis}

## 当前可用文档
{doc_context}
## 已有文档内容片段
{doc_snippet}`],
]);

/**
 * 工具调用阶段：引导 LLM 调用 output_plan 工具
 */
export const planToolPrompt = ChatPromptTemplate.fromMessages([
  ["system", `基于以上分析，调用 output_plan 工具输出结构化任务计划。不要输出文字，只调用工具。`],
  ["human", `{plan_context}`],
]);
