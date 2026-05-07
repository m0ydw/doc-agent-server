/**
 * ================================================================
 * Analyze 阶段 Prompt 模板
 * ================================================================
 *
 * 【改进项 7 - 提示词管理集中化】
 *   新增 buildAnalyzePhaseParams 工厂函数，一次性返回
 *   { thoughtMessages, toolSystemMessage, toolContext }，
 *   消除 globalAgent.ts 中散落的 formatMessages 调用。
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * 思考阶段：流式输出 thought，引导 LLM 正确分类意图
 */
export const analyzeThoughtPrompt = ChatPromptTemplate.fromMessages([
  ["system", `你是一个自动化文档处理管线的分析节点。你的输出将传递给下游执行 Agent，不会直接展示给用户。

你是文档需求分析专家。区分用户的真实意图。

【管线规则】
- 你不会与用户交互。不要询问确认、不要征求许可、不要使用"请注意""您是否希望""建议您"
- 直接输出分析结论，无需礼貌性前缀或征求性后缀

【多文档规则】
- 用户可能同时操作多个文档。分析时请为每个文档列出独立的 operation
- 每个 operation 必须包含 target_document 字段，值为「当前可用文档」列表中的文档名
- 无法确定目标文档时，标注 needs_clarification: true

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

// ================================================================
// 工厂函数（改进项 7）
// ================================================================

/** buildAnalyzePhase 的参数 */
export interface AnalyzePhaseParams {
  /** 意图分类规则（来自 prompts/shared/rules） */
  classification_rules: string;
  /** 防泄露规则（来自 prompts/shared/rules） */
  anti_leak_rules: string;
  /** 用户的原始输入 */
  user_input: string;
  /** 文档上下文（fileRegistry 生成的描述） */
  doc_context: string;
  /** 相关记忆（retrieveMemory 的结果） */
  related_memory: string;
}

/**
 * 构建 Analyze 阶段所需的 prompt 组件
 *
 * 替代原来散落在 globalAgent.ts 中的三行调用：
 *   await analyzeThoughtPrompt.formatMessages(...)
 *   (await analyzeToolPrompt.formatMessages(...))[0].content as string
 *   analysisContext 拼接
 */
export async function buildAnalyzePhase(
  params: AnalyzePhaseParams
): Promise<{
  thoughtMessages: BaseMessage[];
  toolSystemMessage: string;
  toolContext: string;
}> {
  const {
    classification_rules,
    anti_leak_rules,
    user_input,
    doc_context,
    related_memory,
  } = params;

  // 构建 tool 阶段的上下文（用户需求 + 文档 + 记忆）
  const toolContext = `## 用户需求\n${user_input}\n\n## 当前可用文档\n${doc_context}\n\n## 相关历史\n${related_memory}`;

  // 构建 thought 消息列表
  const thoughtMessages = await analyzeThoughtPrompt.formatMessages({
    classification_rules,
    anti_leak_rules,
    user_input,
    doc_context,
    related_memory,
  });

  // 构建 tool system message（取自 tool prompt 的第一条消息）
  const toolMsgs = await analyzeToolPrompt.formatMessages({
    analysis_context: toolContext,
  });
  const toolSystemMessage = toolMsgs[0].content as string;

  return { thoughtMessages, toolSystemMessage, toolContext };
}
