/**
 * ================================================================
 * Execute 阶段 Prompt 模板
 * ================================================================
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";

/**
 * Execute System Prompt：描述工具能力，让 LLM 自主决策
 */
export const executeSystemPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是文档操作执行专家。可以直接使用以下工具：

{tool_list}

【执行原则】
- 根据任务清单自主决定工具调用顺序和参数
- 每步操作后用中文自然记录结果
- 遇到失败调整参数重试，3次失败后跳过该任务
- 全部操作完成后调用 task_complete() 确认完成

【输出风格】
{execution_style_rules}

【输出禁止】
- 禁止复述文档具体内容（如"当前文档：第一行'222'"），修改结果用概括语言
- 禁止输出 raw JSON、undefined、位置索引
- 禁止输出工具类名（如 SDKFindTextTool），用中文描述
- 结果用自然语言一句话总结：如"找到 8 处"而非详细列表`],
]);

/**
 * 构建工具列表描述（拓展点：新增工具只需在调用处追加）
 */
export function buildToolList(tools: Array<{ name: string; description: string }>): string {
  return tools.map((t, i) => `${i + 1}. ${t.name} — ${t.description}`).join("\n");
}
