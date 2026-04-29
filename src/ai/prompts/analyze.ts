/**
 * ================================================================
 * Analyze 阶段 Prompt 模板
 * ================================================================
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";

/**
 * 思考阶段：流式输出 thought，引导 LLM 正确分类意图
 */
export const analyzeThoughtPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是文档需求分析专家。区分用户的真实意图。

【意图分类】
{classification_rules}

【输出规则】
{anti_leak_rules}`],
  ["human", `## 用户需求
{user_input}

## 当前可用文档
{doc_context}

## 相关历史
{related_memory}`],
]);

/**
 * 工具调用阶段：引导 LLM 调用 output_analysis 工具
 */
export const analyzeToolPrompt = ChatPromptTemplate.fromMessages([
  ["system", `基于以上分析，调用 output_analysis 工具输出结构化分析结果。不要输出文字，只调用工具。`],
  ["human", `{analysis_context}`],
]);
