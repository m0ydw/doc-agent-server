/**
 * ================================================================
 * JSON Extractor — 安全的 JSON 字符串提取工具
 * ================================================================
 *
 * 【为什么不用正则 `\{[\s\S]*\}`？】
 *   全局贪婪匹配在文本包含多个花括号块时，会从第一个 `{`
 *   匹配到最后一个 `}`，把中间的非 JSON 文本也包进去。
 *
 * 【标准做法】
 *   通过括号计数算法找到第一个 `{` 及其匹配的 `}`，
 *   并正确处理字符串内的花括号转义。
 *
 * 【LLM 输出场景】
 *   LLM 可能输出：
 *     - 纯 JSON: {"key": "val"}
 *     - Markdown 包裹: ```json\n{...}\n```
 *     - 内嵌文本: 分析结果：{"key": "val"}，以上。
 *   本函数能处理以上所有场景。
 */

// ================================================================
// 主函数
// ================================================================

/**
 * 从任意文本中安全提取第一个合法 JSON 对象
 *
 * 与正则 `\{[\s\S]*\}` 的区别：
 *   - 贪婪正则: "开头{...}中间{...}结尾" → 匹配整个文本 → JSON.parse 失败
 *   - 括号计数: "开头{...}中间{...}结尾" → 只匹配"开头{...}" → 可能成功
 *
 * @param text - 可能包含 JSON 的原始文本
 * @returns 提取到的 JSON 字符串，失败时返回 null
 */
export function extractJson(text: string): string | null {
  // 1. 移除 markdown 代码块标记
  let cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // 2. 找到第一个 `{`
  const start = cleaned.indexOf("{");
  if (start < 0) return null;

  // 3. 括号计数：从 start 位置开始，找到匹配的 `}`
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue; // 字符串内的花括号不参与计数
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // 找到匹配的花括号
        const candidate = cleaned.slice(start, i + 1);
        // 验证是否可以解析
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // 找到匹配括号但 JSON 不合法，继续搜索下一个 }
          continue;
        }
      }
    }
  }

  return null;
}

/**
 * 从 thought Markdown 文本中提取任务清单（extractJson 失败时的兜底）
 *
 * LLM 在 plan phase 的 thought 流中常输出 Markdown 格式：
 *   1. **任务一：替换XX**
 *      *   **目标文档**：文档A.docx
 *      *   **操作说明**：将...改为...
 *
 * 此函数解析这种格式，生成 tasks 数组。
 */
export function extractTasksFromMarkdown(text: string): Record<string, unknown> | null {
  try {
    const tasks: Record<string, unknown>[] = [];
    // 匹配 "N. **任务：XXX**" 或 "任务N：XXX"
    const taskBlocks = text.split(/\n(?=\d+[.\)、]\s*(\*\*)?任务)/);
    if (taskBlocks.length === 0) taskBlocks.push(text);

    for (const block of taskBlocks) {
      // 提取目标文档
      const docMatch = block.match(/目标文档[：:]\s*([^\n*]+)/);
      const targetDocument = docMatch ? docMatch[1].trim() : "";

      // 提取操作说明
      const goalMatch = block.match(/操作说明[：:]\s*([^\n]+)/) || block.match(/\*\*任务[^：:]*[：:]\s*([^*\n]+)/);
      const goal = goalMatch ? goalMatch[1].trim() : "";
      if (!goal && !targetDocument) continue;

      const description = block.replace(/\*+/g, "").trim().slice(0, 200);
      const id = (goal || targetDocument || "task").slice(0, 20);

      tasks.push({
        id,
        goal: goal || targetDocument,
        description,
        target_document: targetDocument || undefined,
      });
    }

    if (tasks.length === 0) return null;
    return { tasks };
  } catch {
    return null;
  }
}

/**
 * 从文本中提取并解析 JSON
 */
export function extractAndParseJson<T = Record<string, unknown>>(text: string): T | null {
  const json = extractJson(text);
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
