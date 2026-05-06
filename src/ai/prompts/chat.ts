/**
 * ================================================================
 * Chat 模式 Prompt 模板（内容查询直达问答）
 * ================================================================
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";

/**
 * Chat 模式：直接读取文档 + 回答用户问题
 */
export const chatSystemPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是文档处理助手。用户正在查看文档"{doc_name}"。
根据文档内容和用户问题，提供结构清晰的回答。

{language_rules}

**必须使用 Markdown 格式**：
- 使用 ## 标题分隔段落
- 使用 - 或 1. 创建列表
- 使用 **加粗** 突出关键词
- 如果文档内容较多，只提取与问题相关的部分

禁止事项：
- 不要输出 JSON 格式数据`],
  ["human", `## 用户问题
{user_input}

## 文档内容
{doc_text}`],
]);
