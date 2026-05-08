/**
 * ================================================================
 * Plan 阶段 Prompt 模板
 * ================================================================
 *
 * 【改进项 7 - 提示词管理集中化】
 *   新增 buildPlanPhase 工厂函数，一次性返回
 *   { thoughtMessages, toolSystemMessage, toolContext }。
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * 思考阶段：流式输出 thought，制定任务计划
 */
export const planThoughtPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是一个自动化文档处理管线的规划节点。你的输出将传递给下游执行 Agent。

你是任务规划专家。根据分析结果和用户原始需求制定任务清单。

【管线规则】
- 你不会与用户交互。不要询问确认、不要征求许可、不要使用"请注意""您是否希望""建议您"
- 直接输出任务清单，无需礼貌性前缀或征求性后缀

【多文档规则】
- 每个任务必须通过 target_document 字段明确指定目标文档（必填）
- 从「当前可用文档」列表中选择文档名称填入 target_document
- 如果操作涉及多个文档，为每个文档创建独立任务

【模板填充规则（template_fill_with_given_data）】
- 当分析结果的 task_type 为 "template_fill_with_given_data" 时：
  1. 用户已在原始需求中提供了完整的键值对数据（如姓名=XXX、电话=XXX）
  2. 参考文档（如"与绘.docx"）仅用于参考格式/布局/位置，不从中提取数据
  3. 计划中的每个任务 description 必须包含用户提供的具体数据值
  4. 禁止生成"从参考文档提取XX"或"读取参考文档内容"类型的任务
  5. 参考文档的任务仅限于读取其表格结构以便定位空白表中的对应位置
- 如果用户同时提供了参考文档和具体数据 → 数据以用户提供为准，参考文档只用于格式

【输出规则】
{anti_leak_rules}`],
  ["human", `## 用户原始需求
{user_input}

## 分析结果
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
  ["system", `你必须调用 output_plan 工具输出结构化任务计划。参照以下 JSON 格式，只调用工具，不输出任何文字：

{{"tasks":[{{"id":"替换公司名","goal":"将全文'公司'替换为'集团'","description":"...","target_document":"XX.docx"}}]}}

如果你不调用工具，后续执行管线将因缺少任务清单而失败。`],
  ["human", `{plan_context}`],
]);

// ================================================================
// 工厂函数（改进项 7）
// ================================================================

/** buildPlanPhase 的参数 */
export interface PlanPhaseParams {
  /** 防泄露规则（来自 prompts/shared/rules） */
  anti_leak_rules: string;
  /** 用户的原始输入（用于 Plan LLM 检查用户提供的具体数据值） */
  user_input: string;
  /** Analyze 阶段的 JSON 结果（cleanAnalysis） */
  clean_analysis: string;
  /** 文档上下文（fileRegistry 生成的描述） */
  doc_context: string;
  /** 可选的文档内容片段（cachedDocText） */
  doc_snippet?: string;
}

/**
 * 构建 Plan 阶段所需的 prompt 组件
 *
 * 替代原来散落在 globalAgent.ts 中的三行调用。
 */
export async function buildPlanPhase(
  params: PlanPhaseParams
): Promise<{
  thoughtMessages: BaseMessage[];
  toolSystemMessage: string;
  toolContext: string;
}> {
  const {
    anti_leak_rules,
    user_input,
    clean_analysis,
    doc_context,
    doc_snippet = "",
  } = params;

  // 构建 tool 阶段的上下文（含用户原始输入，确保 Plan LLM 能看到具体数据值）
  const toolContext = `## 用户原始需求\n${user_input}\n\n## 分析结果\n${clean_analysis}\n\n## 当前可用文档\n${doc_context}` +
    (doc_snippet ? `\n\n## 已有文档内容片段\n${doc_snippet}` : "");

  // 构建 thought 消息列表
  const thoughtMessages = await planThoughtPrompt.formatMessages({
    anti_leak_rules,
    user_input,
    clean_analysis,
    doc_context,
    doc_snippet: doc_snippet || "",
  });

  // 构建 tool system message
  const toolMsgs = await planToolPrompt.formatMessages({
    plan_context: toolContext,
  });
  const toolSystemMessage = toolMsgs[0].content as string;

  return { thoughtMessages, toolSystemMessage, toolContext };
}
