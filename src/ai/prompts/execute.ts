/**
 * ================================================================
 * Execute 阶段 Prompt 模板（旧版单Agent流程）
 *
 * 【使用阶段】旧版 GlobalAgent 的 execute 阶段
 * 【作用】向 LLM 描述可用的工具列表和操作原则，让 LLM 自主决定工具调用
 * 【输入变量】
 *   - tool_list: 工具列表描述文本（通过 buildToolList() 生成）
 *   - execution_style_rules: 执行风格规则
 * 【在新多Agent架构中】此 Prompt 已被 surgicalEditor 节点内的
 *   SURGICAL_SYSTEM_PROMPT 替代，两个 Prompt 定位类似但工具集不同。
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

【数据写入规则】
- 如果任务描述中已包含具体数据值，直接使用这些值写入，不要再去其他文档查找
- 如果用户提供了"参考文档"（如与绘.docx），它仅供格式/布局参考——参考文档中已有的数据是旧数据，不能复制到目标文档。必须使用用户明确提供的数据值
- 目标文档中的空白字段应该用用户提供的数据填充，不是用参考文档的旧数据填充
- sdk_read_table 返回的 cells[].ref 可直接传给 sdk_set_text 写入，无需二次查找
- 读取表格/文档结构只需调用一次对应工具，拿到结果后立即开始写入
- 禁止对同一查询反复调用 find_text / get_text 超过 2 次
- 禁止在用户已完整提供所有数据项后，仍报告"缺少信息"并停止执行

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
