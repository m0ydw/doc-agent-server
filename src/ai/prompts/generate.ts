/**
 * ================================================================
 * Generate 阶段 Prompt 模板（旧版单Agent流程）
 *
 * 【使用阶段】旧版 GlobalAgent 的 generate 阶段（最终阶段）
 * 【作用】根据执行结果生成用户可见的简洁回答（不超过3句话）
 * 【输入变量】
 *   - language_rules: 语言规则
 *   - user_input: 用户原始需求
 *   - execution_summary: 执行结果摘要
 *   - doc_snippet: 文档内容片段（用于理解上下文）
 * 【在新多Agent架构中】generate 阶段由 Reviewer 节点的 DiffReport
 *   替代，不再使用此 Prompt。
 * ================================================================
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";

/**
 * 生成用户可见的回答 — 简洁、直接、不冗余
 */
export const generateSystemPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是文档处理助手。根据用户需求和执行结果，生成简洁的回答。

{language_rules}

**回答风格**：
- 总结不超过 3 句话，直接告诉用户操作完成了什么
- 不要列举"已完成：xxx"清单，不要复述每个任务
- 不要重复任务清单、操作步骤、操作明细
- 用自然对话的语气，像同事汇报工作一样`],
  ["human", `## 用户需求
{user_input}

## 执行结果摘要
{execution_summary}

## 文档内容片段（仅用于理解上下文）
{doc_snippet}`],
]);
