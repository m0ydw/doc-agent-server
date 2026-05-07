/**
 * phaseHelpers — 流式阶段的辅助函数
 */

import { sseThought } from "../core/sseEmitter";

const THOUGHT_CHUNK_SIZE = 150;

/** 发出警告事件 */
export async function* emitWarning(message: string): AsyncGenerator<string, void, unknown> {
  console.warn("[phaseStrategy] " + message);
  yield sseThought("[警告] " + message);
}

/** 按 THOUGHT_CHUNK_SIZE 分片发出 thought SSE 事件 */
export async function* emitThoughtChunks(text: string): AsyncGenerator<string, void, unknown> {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let remaining = cleaned;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, THOUGHT_CHUNK_SIZE);
    yield sseThought(chunk);
    remaining = remaining.slice(THOUGHT_CHUNK_SIZE);
  }
}

/** 清理 JSON 文本（去除 markdown 代码块和多余空白） */
export function cleanJsonText(text: string): string | null {
  let cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  if (!cleaned) return null;
  if (!cleaned.startsWith("{")) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    cleaned = match ? match[0] : cleaned;
  }
  return cleaned;
}
