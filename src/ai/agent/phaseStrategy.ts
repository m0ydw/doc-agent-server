/**
 * PhaseStreamStrategy — 流式阶段策略抽象
 *
 * DualCallStrategy：两次 LLM 请求（标准 bindTools API）
 * 工厂函数 createPhaseStrategy 通过环境变量可切换策略。
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { sseThought } from "../core/sseEmitter";
import { logLlmStreamStart, logLlmStreamFull, logLlmInvokeStart, logLlmInvokeResult } from "../core/debugLogger";
import { emitWarning } from "./phaseHelpers";

// ================================================================
// thought 流式切割阈值
// ================================================================

const THOUGHT_CHUNK_SIZE = 150;

// ================================================================
// 策略接口
// ================================================================

export interface PhaseStreamStrategy {
  readonly name: string;
  execute(
    llm: ChatOpenAI,
    thoughtMessages: BaseMessage[],
    outputTool: StructuredTool,
    toolSystemMessage: string,
    toolContext: string
  ): AsyncGenerator<string, Record<string, unknown> | null, unknown>;
}

// ================================================================
// DualCallStrategy — 标准 bindTools API（两次 LLM 请求）
// ================================================================

export class DualCallStrategy implements PhaseStreamStrategy {
  readonly name = "dualCall";

  async *execute(
    llm: ChatOpenAI,
    thoughtMessages: BaseMessage[],
    outputTool: StructuredTool,
    toolSystemMessage: string,
    toolContext: string
  ): AsyncGenerator<string, Record<string, unknown> | null, unknown> {
    // 第1次：流式输出 thought
    let stream: AsyncIterable<unknown>;
    try {
      const endStreamLog = logLlmStreamStart("DualCall.thought (流式)");
      stream = await llm.stream(thoughtMessages);
      let thoughtFull = "";
      const originalStream = stream;
      stream = (async function* () {
        for await (const chunk of originalStream as AsyncIterable<{ content: { toString(): string } }>) {
          thoughtFull += chunk.content.toString();
          yield chunk;
        }
        logLlmStreamFull("DualCall.thought", thoughtFull);
        endStreamLog?.();
      })();
    } catch (e: unknown) {
      yield* emitWarning(`思考流启动失败：${(e as Error).message?.slice(0, 200)}`);
      return null;
    }

    let buffer = "";
    for await (const chunk of stream as AsyncIterable<{ content: { toString(): string } }>) {
      buffer += chunk.content.toString().replace(/\n/g, " ");
      while (buffer.length >= THOUGHT_CHUNK_SIZE) {
        const line = buffer.slice(0, THOUGHT_CHUNK_SIZE).trim();
        if (line) yield sseThought(line);
        buffer = buffer.slice(THOUGHT_CHUNK_SIZE);
      }
    }
    if (buffer.trim()) yield sseThought(buffer.trim());

    // 第2次：tool calling 获取结构化数据
    console.log("[phaseStrategy:" + this.name + "] 开始 tool calling, tool=" + outputTool.name);
    const endInvokeLog = logLlmInvokeStart("DualCall.bindTools (结构化)");
    try {
      const llmWithTools = llm.bindTools([outputTool]);
      const response = await llmWithTools.invoke([
        new SystemMessage(toolSystemMessage),
        new HumanMessage(toolContext),
      ]);

      const toolCalls = response.tool_calls;
      logLlmInvokeResult("DualCall.bindTools", response.content?.toString() || null, toolCalls);
      endInvokeLog?.();

      if (toolCalls && toolCalls.length > 0) {
        const args = toolCalls[0].args;
        console.log("[phaseStrategy:" + this.name + "] Tool calling 成功, keys=" + Object.keys(args).join(","));
        return args as Record<string, unknown>;
      }

      yield* emitWarning("Tool calling: LLM 未调用工具，返回 null");
      return null;
    } catch (e: unknown) {
      endInvokeLog?.();
      yield* emitWarning(`结构化输出请求失败：${(e as Error).message?.slice(0, 200)}`);
      return null;
    }
  }
}

// ================================================================
// 工厂函数
// ================================================================

export function createPhaseStrategy(_modelName?: string): PhaseStreamStrategy {
  // 默认使用标准 LangChain bindTools API
  console.log("[phaseStrategy] 使用 DualCallStrategy（标准 bindTools API）");
  return new DualCallStrategy();
}
