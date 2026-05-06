/**
 * ================================================================
 * PhaseStreamStrategy — 流式阶段策略抽象
 * ================================================================
 *
 * 【改进项 0 - 优化双调用模式】
 *   当前的 streamPhaseWithSeparation 为了同时拿到流式思考和结构化 JSON，
 *   发起了两次 LLM 请求。本模块通过策略模式抽象：
 *
 *   策略1 DualCallStrategy（当前逻辑）：两次请求，最兼容
 *   策略2 SingleCallSeparatorStrategy（优化）：单请求 + 分隔符分离
 *
 * 【改进项 5 - 错误处理】
 *   - 失败时通过 Generator yield [warning] 事件，前端可感知降级
 *   - 同时 console.warn 记录到服务端日志
 *
 * 【设计原则】
 *   - 策略之间完全可互换，消费方无感知
 *   - 通过 createPhaseStrategy() 工厂函数按模型能力选择策略
 *   - 后续新增模型支持 withStructuredOutput 时，只需新增策略类
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";

// ================================================================
// 1. 策略接口
// ================================================================

/**
 * 流式阶段策略接口
 * 实现此接口来定义不同的 LLM 调用策略
 */
export interface PhaseStreamStrategy {
  /** 策略名称（用于日志和诊断） */
  readonly name: string;

  /**
   * 执行流式阶段
   * @param llm - LLM 实例
   * @param thoughtMessages - 思考阶段的 prompt 消息列表
   * @param outputTool - 结构化输出工具
   * @param toolSystemMessage - 工具调用阶段的 system prompt
   * @param toolContext - 工具调用阶段的上下文
   * @yields [thought]xxx\n — 逐片流式思考文本
   * @returns 结构化数据对象，失败时为 null
   */
  execute(
    llm: ChatOpenAI,
    thoughtMessages: BaseMessage[],
    outputTool: StructuredTool,
    toolSystemMessage: string,
    toolContext: string
  ): AsyncGenerator<string, Record<string, unknown> | null, unknown>;
}

// ================================================================
// 2. 策略实现：双调用模式（机械搬迁自 globalAgent.ts）
// ================================================================

/**
 * DualCallStrategy — 两次 LLM 调用策略
 *
 * 原理：
 *   第1次 llm.stream() → 纯思考过程 → yield [thought] 事件
 *   第2次 llm.bindTools().invoke() → 结构化 JSON → 返回对象
 *
 * 优点：100% 兼容所有模型
 * 缺点：延迟和 token 消耗翻倍
 */
export class DualCallStrategy implements PhaseStreamStrategy {
  readonly name = "dualCall";

  async *execute(
    llm: ChatOpenAI,
    thoughtMessages: BaseMessage[],
    outputTool: StructuredTool,
    toolSystemMessage: string,
    toolContext: string
  ): AsyncGenerator<string, Record<string, unknown> | null, unknown> {
    // ===== 第1次：流式输出 thought =====
    let stream: AsyncIterable<any>;
    try {
      stream = await llm.stream(thoughtMessages);
    } catch (e: any) {
      yield* emitWarning(`思考流启动失败：${e.message?.slice(0, 200)}`);
      return null;
    }

    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk.content.toString().replace(/\n/g, " ");
      // 150 字符自然断句（避免碎片化，与原来一致）
      if (buffer.length >= 150) {
        const line = buffer.trim();
        if (line) yield "[thought]" + line + "\n";
        buffer = "";
      }
    }
    if (buffer.trim()) {
      yield "[thought]" + buffer.trim() + "\n";
    }

    // ===== 第2次：tool calling 获取结构化数据 =====
    console.log("[phaseStrategy:" + this.name + "] 开始 tool calling, tool=" + outputTool.name);
    try {
      const llmWithTools = llm.bindTools([outputTool]);
      const response = await llmWithTools.invoke([
        new SystemMessage(toolSystemMessage),
        new HumanMessage(toolContext),
      ]);

      const toolCalls = response.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        const args = toolCalls[0].args;
        console.log("[phaseStrategy:" + this.name + "] Tool calling 成功, keys=" +
          Object.keys(args).join(","));
        return args as Record<string, unknown>;
      }

      yield* emitWarning("Tool calling: LLM 未调用工具，返回 null");
      return null;
    } catch (e: any) {
      yield* emitWarning(`结构化输出请求失败：${e.message?.slice(0, 200)}`);
      return null;
    }
  }
}

// ================================================================
// 3. 策略实现：单调用 + 分隔符模式（优化方案）
// ================================================================

/**
 * SingleCallSeparatorStrategy — 单次 LLM 调用 + 分隔符分离策略
 *
 * 原理：
 *   在同一个流式响应中，LLM 先输出思考，然后输出 "---JSON---" 分隔符，
 *   再输出纯 JSON。前端同时消费思考流式事件，后端解析 JSON。
 *
 * 优点：单次请求，延迟和 token 消耗减半
 * 缺点：依赖 LLM 遵循分隔符约定（非标准化行为，部分模型可能不遵守）
 *
 * 消费方式（与 DualCallStrategy 完全一致）：
 *   - 逐片 yield [thought] 事件 → 前端实时渲染
 *   - 流末尾返回 parsed JSON 对象 → 后端阶段逻辑使用
 */
export class SingleCallSeparatorStrategy implements PhaseStreamStrategy {
  readonly name = "singleCallSeparator";

  private static readonly SEPARATOR = "---JSON---";

  async *execute(
    llm: ChatOpenAI,
    thoughtMessages: BaseMessage[],
    outputTool: StructuredTool,
    toolSystemMessage: string,
    toolContext: string
  ): AsyncGenerator<string, Record<string, unknown> | null, unknown> {
    // 构建合并后的 prompt（在 thought prompt 后追加结构输出指令）
    const mergedMessages: BaseMessage[] = [
      ...thoughtMessages,
      new HumanMessage(
        `\n\n在完成以上思考后，请用 "${SingleCallSeparatorStrategy.SEPARATOR}" 作为分隔，` +
        `然后输出纯 JSON。不要输出 markdown 代码块标记（\`\`\`），只输出 JSON 对象本身。\n\n` +
        `${toolContext}`
      ),
    ];

    let stream: AsyncIterable<any>;
    try {
      stream = await llm.stream(mergedMessages);
    } catch (e: any) {
      yield* emitWarning(`单调用流启动失败：${e.message?.slice(0, 200)}`);
      return null;
    }

    let fullText = "";
    let separatorFound = false;
    let jsonBuffer = "";
    let thoughtBuffer = "";

    // 逐 chunk 消费
    for await (const chunk of stream) {
      const raw = chunk.content.toString();
      fullText += raw;

      if (!separatorFound) {
        // 在全文累积中查找分隔符
        const sepIdx = fullText.indexOf(SingleCallSeparatorStrategy.SEPARATOR);
        if (sepIdx >= 0) {
          separatorFound = true;

          // 分隔符之前的内容是 thought（除去可能已输出的部分）
          const beforeSep = fullText.slice(0, sepIdx);
          const remainingThought = beforeSep.slice(thoughtBuffer.length);

          if (remainingThought) {
            thoughtBuffer += remainingThought;
            yield* emitThoughtChunks(remainingThought);
          }

          // 分隔符之后的内容是 JSON（累积到 jsonBuffer）
          jsonBuffer = fullText.slice(sepIdx + SingleCallSeparatorStrategy.SEPARATOR.length);
        } else {
          // 分隔符尚未出现：逐块向前端发送 thought
          // 保留一个安全边界（分隔符长度），避免提前发送分隔符部分
          const safeBoundary = Math.max(0, fullText.length - SingleCallSeparatorStrategy.SEPARATOR.length);
          if (safeBoundary > thoughtBuffer.length) {
            const newThought = fullText.slice(thoughtBuffer.length, safeBoundary);
            thoughtBuffer = fullText.slice(0, safeBoundary);
            yield* emitThoughtChunks(newThought);
          }
        }
      } else {
        // 分隔符已出现：后续内容全部累积到 jsonBuffer
        jsonBuffer += raw;
      }
    }

    // 流结束处理
    if (!separatorFound) {
      // 分隔符未出现：整个输出都当作 thought（LLM 未遵守约定）
      yield* emitWarning("LLM 未输出分隔符，整个响应作为思考内容");
      const remaining = fullText.slice(thoughtBuffer.length);
      if (remaining) yield* emitThoughtChunks(remaining);
      return null;
    }

    // 解析 JSON
    const cleanedJson = cleanJsonText(jsonBuffer);
    if (!cleanedJson) {
      yield* emitWarning("JSON 提取失败（分隔符后无可解析内容）");
      return null;
    }

    try {
      const parsed = JSON.parse(cleanedJson);
      console.log("[phaseStrategy:" + this.name + "] JSON 解析成功, keys=" +
        Object.keys(parsed).join(","));
      return parsed as Record<string, unknown>;
    } catch (e: any) {
      yield* emitWarning(`JSON 解析失败：${e.message?.slice(0, 200)}`);
      return null;
    }
  }
}

// ================================================================
// 4. 工厂函数
// ================================================================

/**
 * 根据模型能力创建流式策略
 *
 * 当前默认使用 DualCallStrategy（最兼容），未来当模型支持
 * withStructuredOutput + 自定义流式解析器时切换为单调用策略。
 *
 * 可以通过环境变量 PHASE_STRATEGY 手动切换：
 *   - PHASE_STRATEGY=singleCall  → 使用 SingleCallSeparatorStrategy
 *   - PHASE_STRATEGY=dualCall    → 使用 DualCallStrategy（默认）
 */
export function createPhaseStrategy(modelName?: string): PhaseStreamStrategy {
  const envStrategy = process.env.PHASE_STRATEGY?.trim().toLowerCase();

  if (envStrategy === "singleCall" || envStrategy === "singlecall") {
    console.log("[phaseStrategy] 使用 SingleCallSeparatorStrategy（环境变量指定）");
    return new SingleCallSeparatorStrategy();
  }

  // 默认使用 DualCallStrategy（最兼容，100% 可靠）
  console.log("[phaseStrategy] 使用 DualCallStrategy（默认，最兼容）");
  return new DualCallStrategy();
}

// ================================================================
// 5. 辅助函数
// ================================================================

/**
 * 统一 warning 辅助：向 Generator yield [warning] 事件 + console.warn
 */
export function* emitWarning(message: string): Generator<string, void, unknown> {
  console.warn("[phaseStrategy]", message);
  yield "[warning]" + message + "\n";
}

/**
 * 逐片输出 thought 内容（保持与 DualCallStrategy 一致的 150 字符断句）
 * 输入是一段已累积的文本，按自然断句分片输出
 */
function* emitThoughtChunks(text: string): Generator<string, void, unknown> {
  let buffer = text.replace(/\n/g, " ");
  while (buffer.length >= 150) {
    const line = buffer.slice(0, 150).trim();
    if (line) yield "[thought]" + line + "\n";
    buffer = buffer.slice(150);
  }
  if (buffer.trim()) {
    yield "[thought]" + buffer.trim() + "\n";
  }
}

/**
 * 清理 JSON 文本：去除 markdown 代码块标记、前后空白
 */
function cleanJsonText(text: string): string {
  let cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // 尝试提取最外层花括号包裹的内容
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];

  return cleaned;
}
