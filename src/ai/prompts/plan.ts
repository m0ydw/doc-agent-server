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

// ================================================================
// 工厂函数（改进项 7）
// ================================================================

/** buildPlanPhase 的参数 */
export interface PlanPhaseParams {
  /** 防泄露规则（来自 prompts/shared/rules） */
  anti_leak_rules: string;
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
    clean_analysis,
    doc_context,
    doc_snippet = "",
  } = params;

  // 构建 tool 阶段的上下文
  const toolContext = `## 分析结果\n${clean_analysis}\n\n## 当前可用文档\n${doc_context}` +
    (doc_snippet ? `\n\n## 已有文档内容片段\n${doc_snippet.substring(0, 2000)}` : "");

  // 构建 thought 消息列表
  const thoughtMessages = await planThoughtPrompt.formatMessages({
    anti_leak_rules,
    clean_analysis,
    doc_context,
    doc_snippet: doc_snippet ? doc_snippet.substring(0, 2000) : "",
  });

  // 构建 tool system message
  const toolMsgs = await planToolPrompt.formatMessages({
    plan_context: toolContext,
  });
  const toolSystemMessage = toolMsgs[0].content as string;

  return { thoughtMessages, toolSystemMessage, toolContext };
}
