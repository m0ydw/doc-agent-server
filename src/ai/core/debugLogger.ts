/**
 * ================================================================
 * Debug Logger — LLM 输出全量日志（通过环境变量一键开关）
 * ================================================================
 *
 * 【用法】
 *   设置环境变量 DEBUG_LLM_OUTPUT=true 启用全量日志。
 *   关闭后所有函数退化为 no-op，零性能损耗。
 *
 * 【清理】
 *   搜索 [LLM-DEBUG] 前缀可定位所有日志调用点，
 *   搜索 import.*debugLogger 可定位所有导入。
 *
 * 【环境变量】
 *   DEBUG_LLM_OUTPUT=true   → 启用全量 LLM 输出日志
 *   （不设或设其他值）       → 关闭，零开销
 */

const DEBUG_ENABLED = process.env.DEBUG_LLM_OUTPUT === "true";

const PREFIX = "[LLM-DEBUG]";

/** 耗时单位：毫秒 */
function ms(start: [number, number]): string {
  const diff = process.hrtime(start);
  return (diff[0] * 1000 + diff[1] / 1e6).toFixed(1) + "ms";
}

// ================================================================
// 导出函数（DEBUG_ENABLED=false 时均为 no-op）
// ================================================================

/** LLM 流式调用开始 */
export function logLlmStreamStart(
  label: string,
  model?: string
): (() => void) | undefined {
  if (!DEBUG_ENABLED) return undefined;
  const start = process.hrtime();
  const modelInfo = model ? ` model=${model}` : "";
  console.log(`${PREFIX} [stream:start] ${label}${modelInfo}`);
  return () => console.log(`${PREFIX} [stream:end] ${label} 耗时=${ms(start)}`);
}

/** LLM 流式调用中：输出完整累积文本 */
export function logLlmStreamFull(label: string, fullText: string): void {
  if (!DEBUG_ENABLED) return;
  console.log(
    `${PREFIX} [stream:full] ${label} 全文(${
      fullText.length
    }字符):\n${fullText.slice(0, 5000)}${
      fullText.length > 5000 ? "\n...(已截断)" : ""
    }`
  );
}

/** LLM invoke/bindTools 调用开始 */
export function logLlmInvokeStart(
  label: string,
  model?: string
): (() => void) | undefined {
  if (!DEBUG_ENABLED) return undefined;
  const start = process.hrtime();
  const modelInfo = model ? ` model=${model}` : "";
  console.log(`${PREFIX} [invoke:start] ${label}${modelInfo}`);
  return () => console.log(`${PREFIX} [invoke:end] ${label} 耗时=${ms(start)}`);
}

/** LLM invoke 返回的原始内容 */
export function logLlmInvokeResult(
  label: string,
  content: string | null,
  toolCalls?: unknown
): void {
  if (!DEBUG_ENABLED) return;
  if (content) {
    console.log(
      `${PREFIX} [invoke:content] ${label} (${
        content.length
      }字符):\n${content.slice(0, 3000)}`
    );
  }
  if (toolCalls) {
    console.log(
      `${PREFIX} [invoke:tools] ${label} tool_calls:`,
      JSON.stringify(toolCalls, null, 2).slice(0, 2000)
    );
  }
}

/** 通用阶段日志 */
export function logPhase(label: string, detail?: string): void {
  if (!DEBUG_ENABLED) return;
  const detailStr = detail ? ` ${detail}` : "";
  console.log(`${PREFIX} [phase] ${label}${detailStr}`);
}

/** 耗时标记（用于非 LLM 的关键步骤） */
export function logTiming(label: string, durationMs: number): void {
  if (!DEBUG_ENABLED) return;
  console.log(`${PREFIX} [timing] ${label} 耗时=${durationMs.toFixed(1)}ms`);
}
