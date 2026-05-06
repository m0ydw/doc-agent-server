/**
 * ================================================================
 * PhaseRunner — 通用阶段执行器
 * ================================================================
 *
 * 【改进项 2 - 消除重复】
 *   原来 Analyze / Plan / Validate 三个阶段在 streamProcess 中各自有
 *   30+ 行几乎相同的代码。本模块将其抽象为一个通用的 runPhase 方法。
 *   每个阶段只需传入 PhaseConfig，一行调用完成。
 *
 * 【职责】
 *   1. 构建 prompt（调用 config.promptBuilder）
 *   2. 调用流式策略（strategy.execute）→ yield [thought] 事件
 *   3. 从 JSON 返回值生成 phase summary → yield [content] 事件
 *   4. 发出 [phase] 阶段结束事件
 *   5. JSON 失败时的 fallback 处理（使用 config.fallbackJson）
 *
 * 【与 streamProcess 的关系】
 *   streamProcess 从原来的 150+ 行阶段循环收缩为 3 个 runPhase 调用。
 */

import { ChatOpenAI } from "@langchain/openai";
import type { StructuredTool } from "@langchain/core/tools";
import type { PhaseConfig, PhaseOutput } from "./types";
import type { PhaseStreamStrategy } from "./phaseStrategy";
import { emitWarning } from "./phaseStrategy";

// ================================================================
// 1. 主入口：runPhase
// ================================================================

/**
 * 执行一个阶段（Analyze / Plan / Validate）
 *
 * @param llm - LLM 实例
 * @param strategy - 流式策略（DualCall 或 SingleCall）
 * @param config - 阶段配置
 * @param cachedContext - 可选透传上下文（如 cachedDocText，暂预留）
 * @yields [thought] / [content] / [phase] / [warning] SSE 事件
 * @returns 该阶段的输出对象（可能为 null 表示完全失败）
 */
export async function* runPhase<T extends PhaseOutput>(
  llm: ChatOpenAI,
  strategy: PhaseStreamStrategy,
  config: PhaseConfig<T>,
  _cachedContext?: string
): AsyncGenerator<string, T | null, unknown> {
  const { phaseName, promptBuilder, outputTool, summaryBuilder, fallbackJson } = config;

  // ===== 1. 构建 prompt =====
  let promptData: {
    thoughtMessages: import("@langchain/core/messages").BaseMessage[];
    toolSystemMessage: string;
    toolContext: string;
  };
  try {
    promptData = await promptBuilder();
  } catch (e: any) {
    yield* emitWarning(`[${phaseName}] Prompt 构建失败：${e.message?.slice(0, 200)}`);
    return null;
  }

  // ===== 2. 调用流式策略 → yield [thought] 事件 =====
  let structuredData: Record<string, unknown> | null = null;
  const strategyGen = strategy.execute(
    llm,
    promptData.thoughtMessages,
    outputTool,
    promptData.toolSystemMessage,
    promptData.toolContext
  );

  let strategyResult = await strategyGen.next();
  while (!strategyResult.done) {
    yield strategyResult.value as string;
    strategyResult = await strategyGen.next();
  }
  structuredData = strategyResult.value;

  // ===== 3. 处理 JSON 返回值 =====
  let phaseObj: T | null = null;

  if (structuredData && typeof structuredData === "object") {
    phaseObj = structuredData as T;

    // 生成 phase summary 并 yield [content] 事件
    const summary = summaryBuilder(phaseObj);
    if (summary) {
      const lines = summary.split("\n");
      for (const line of lines) {
        if (line.trim()) yield "[content]" + line.trim() + "\n";
      }
    }
  } else {
    // JSON 失败时的 fallback
    console.warn("[phaseRunner:" + phaseName + "] 结构化输出为 null，使用 fallback");
    try {
      phaseObj = JSON.parse(fallbackJson) as T;
    } catch {
      // fallback 也解析失败（极端情况）
      yield* emitWarning(`[${phaseName}] 结构化输出和 fallback 均失败`);
      phaseObj = null;
    }
  }

  // ===== 4. 发出阶段结束事件 =====
  yield "[phase]" + getPhaseEndText(phaseName) + "\n";

  return phaseObj;
}

// ================================================================
// 2. 辅助函数
// ================================================================

/** 阶段名 → 中文结束文本 */
function getPhaseEndText(phaseName: string): string {
  switch (phaseName) {
    case "analyze": return "分析完成";
    case "plan": return "计划制定完成";
    case "validate": return "验证完成";
    default: return phaseName + "完成";
  }
}
