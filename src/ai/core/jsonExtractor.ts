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
 *   本模块能处理以上所有场景。
 *
 * 【在整体流程中的位置】
 *   被 workflow 的各个节点使用：orchestrator（意图分析结果）、
 *   docAnalyst（文档结构）、reviewer（验证报告）等节点
 *   都通过本模块从 LLM 文本输出中提取结构化 JSON。
 * ================================================================
 */

// ================================================================
// 主函数：安全 JSON 提取
// ================================================================

/**
 * 从任意文本中安全提取第一个合法 JSON 对象
 *
 * 【算法说明】括号计数法
 * 1. 从第一个 `{` 开始，逐字符遍历
 * 2. 遇到 `{` → depth++，遇到 `}` → depth--
 * 3. 当 depth 回到 0 时，表示找到了与起始 `{` 匹配的 `}`
 * 4. 对这段内容做 JSON.parse 验证
 *
 * 【与正则的区别】
 *   - 贪婪正则: "开头{...}中间{...}结尾" → 匹配整个文本 → JSON.parse 失败
 *   - 括号计数: "开头{...}中间{...}结尾" → 只匹配"开头{...}" → 可能成功
 *
 * 【edge case 处理】
 *   - 字符串内的花括号：通过 inString 标志忽略
 *   - 转义字符：通过 escape 标志跳过
 *   - Markdown 代码块：先 strip 掉
 *
 * @param text - 可能包含 JSON 的原始文本
 * @returns 提取到的纯 JSON 字符串，失败时返回 null
 */
export function extractJson(text: string): string | null {
  // 1. 移除 markdown 代码块标记（不影响字符串内内容）
  let cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // 2. 找到第一个 `{`
  const start = cleaned.indexOf("{");
  if (start < 0) return null;

  // 3. 括号计数：从 start 位置开始，找到匹配的 `}`
  let depth = 0;      // 当前嵌套深度
  let inString = false; // 是否在 JSON 字符串值内部
  let escape = false;   // 是否刚遇到转义符 `\`

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    // 在字符串内遇到 `\` → 标记转义状态
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    // 遇到未转义的双引号 → 切换字符串状态
    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }

    // 在字符串内部的花括号不参与计数
    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // 找到匹配的花括号，截取候选 JSON
        const candidate = cleaned.slice(start, i + 1);
        // 验证是否可以解析为合法 JSON
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
 * 从 thought Markdown 文本中提取任务清单（extractJson 失败时的兜底策略）
 *
 * 【使用场景】
 * LLM 在 plan phase 的 thought 流中常输出 Markdown 格式而非纯 JSON：
 *   1. **任务一：替换XX**
 *      *   **目标文档**：文档A.docx
 *      *   **操作说明**：将...改为...
 *
 * 当 extractJson 无法从 LLM 输出中提取到合法 JSON 时，
 * 调用此函数作为降级方案，从 Markdown 结构中解析出 tasks 数组。
 *
 * 【解析策略】
 * 1. 按任务编号分割文本块
 * 2. 从每个块中提取"目标文档"和"操作说明"字段
 * 3. 生成符合下游期望的 tasks 数组格式
 *
 * @param text LLM 输出的原始文本（Markdown 格式）
 * @returns 包含 tasks 数组的对象；解析失败返回 null
 */
export function extractTasksFromMarkdown(text: string): Record<string, unknown> | null {
  try {
    const tasks: Record<string, unknown>[] = [];
    // 匹配 "N. **任务：XXX**" 或 "任务N：XXX" 等格式
    const taskBlocks = text.split(/\n(?=\d+[.\)、]\s*(\*\*)?任务)/);
    if (taskBlocks.length === 0) taskBlocks.push(text);

    for (const block of taskBlocks) {
      // 提取目标文档
      const docMatch = block.match(/目标文档[：:]\s*([^\n*]+)/);
      const targetDocument = docMatch ? docMatch[1].trim() : "";

      // 提取操作说明或任务描述
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
 * 从文本中提取 JSON 并解析为对象（extractJson + JSON.parse 的一站式封装）
 *
 * 这是最常用的顶层调用接口，一步完成：文本 → JSON 字符串 → 解析对象。
 * 被 orchestrator、docAnalyst、reviewer 等节点广泛使用。
 *
 * @param text 可能包含 JSON 的原始文本
 * @returns 解析后的对象；提取或解析失败返回 null
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
