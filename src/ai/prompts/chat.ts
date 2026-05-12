/**
 * ================================================================
 * Chat 模式 Prompt 模板（文档问答，无需阶段流水线）
 *
 * 【使用阶段】由 GlobalAgent.runChatMode() 使用
 * 【作用】将文档内容作为上下文，直接回答用户的问题
 * 【输入变量】
 *   - doc_name: 文档文件名
 *   - language_rules: 语言规则（来自 prompts/shared/rules.ts）
 *   - user_input: 用户问题
 *   - doc_text: 文档纯文本内容（截断到 MAX_DOC_CONTEXT_CHARS）
 * ================================================================
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";

/**
 * Chat 模式：直接回答用户关于文档内容的问题
 */
export const chatSystemPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是文档处理助手。用户正在查看文档"{doc_name}"。
根据文档内容和用户问题，直接回答。

{language_rules}

**回答风格**：
- 直接回答用户的问题，不要生成多章节报告
- 用简洁自然的中文，像对话一样
- 如果用户问"这个文档讲了什么"，简要总结主题和要点即可
- 如果用户问具体内容，直接回答那部分
- 使用 Markdown 的列表、加粗辅助表达`],
  ["human", `## 用户问题
{user_input}

## 文档内容
{doc_text}`],
]);
