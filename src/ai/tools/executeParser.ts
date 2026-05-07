/**
 * executeParser — ExecuteTool 结果解析器
 *
 * 从 ExecuteTool 输出中提取结构化数据和文档片段。
 */

export interface ToolCallRecord {
  tool: string;
  args: string;
  result: string;
  status: "success" | "failed" | "skipped";
}

const ERROR_MSG_MAX_LEN = 150;
const RAW_RESULT_HEAD_LEN = 120;

/**
 * 解析 ExecuteTool 返回的 JSON 字符串
 */
export function parseExecuteResult(
  rawResult: string
): { executionLog: string; toolCalls: ToolCallRecord[]; success: boolean | null } {
  try {
    const parsed = JSON.parse(rawResult);
    const executionLog = parsed.execution_log || rawResult;
    const toolCalls: ToolCallRecord[] = parsed.tool_calls || [];
    const success: boolean | null = typeof parsed.success === "boolean" ? parsed.success : null;
    return { executionLog, toolCalls, success };
  } catch (e: unknown) {
    const err = e as Error;
    console.warn(
      "[ExecuteTool] JSON 解析失败，使用原始日志作为 execution_log，" +
      "err=" + err.message?.slice(0, ERROR_MSG_MAX_LEN) +
      ", raw_len=" + rawResult.length +
      ", raw_head=" + rawResult.slice(0, RAW_RESULT_HEAD_LEN).replace(/\n/g, "\\n")
    );
    return { executionLog: rawResult, toolCalls: [], success: null };
  }
}

/**
 * 从 ExecuteTool 返回的 JSON 中提取文档片段（sdk_get_text 的结果）
 */
export function extractDocSnippet(rawResult: string, maxLength: number = 4000): string {
  try {
    const parsed = JSON.parse(rawResult);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      for (const tc of parsed.tool_calls) {
        if (tc.tool === "sdk_get_text" && tc.result) {
          const textMatch = tc.result.match(/：(.+)/);
          const snippet = textMatch ? textMatch[1] : tc.result;
          return snippet.length > maxLength
            ? snippet.substring(0, maxLength) + "...(已截断)"
            : snippet;
        }
      }
    }
  } catch {
    // 提取失败，返回空字符串
  }
  return "";
}
