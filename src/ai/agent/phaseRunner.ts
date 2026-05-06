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
 * 【SSE 标准化（改进项 #5）】
 *   使用 sseContent / sseWarning 等标准 SSE emitter，替代
 *   `[prefix]content\n` 自定义格式。
 */

import { ChatOpenAI } from "@langchain/openai";
import type { StructuredTool } from "@langchain/core/tools";
import type { PhaseConfig, PhaseOutput } from "./types";
import type { PhaseStreamStrategy } from "./phaseStrategy";
import { emitWarning } from "./phaseStrategy";
import { sseContent, ssePhaseEnd } from "../core/sseEmitter";

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

  // ===== 2. 调用流式策略 → 透传 yielded SSE 事件 =====
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

  // ===== 3. 处理 JSON 返回值 → yield [content] 事件 =====
  let phaseObj: T | null = null;

  if (structuredData && typeof structuredData === "object") {
    phaseObj = structuredData as T;

    const summary = summaryBuilder(phaseObj);
    if (summary) {
      const lines = summary.split("\n");
      for (const line of lines) {
        if (line.trim()) yield sseContent(line.trim());
      }
    }
  } else {
    console.warn("[phaseRunner:" + phaseName + "] 结构化输出为 null，使用 fallback");
    try {
      phaseObj = JSON.parse(fallbackJson) as T;
    } catch {
      yield* emitWarning(`[${phaseName}] 结构化输出和 fallback 均失败`);
      phaseObj = null;
    }
  }

  // ===== 4. 发出阶段结束事件 =====
  yield ssePhaseEnd(phaseName);

  return phaseObj;
}
