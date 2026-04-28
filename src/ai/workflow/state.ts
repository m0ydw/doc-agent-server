/**
 * ================================================================
 * 工作流状态定义（LangGraph State）
 * ================================================================
 *
 * LangGraph 的 State 是整个工作流的"共享内存"。
 * 每个节点函数读取状态中的某些字段，写入其他字段。
 * 条件边根据状态中的字段值决定下一步走向。
 *
 * Annotation<T>() 的参数格式:
 *   - 无默认值: Annotation<T>()
 *   - 有默认值: Annotation<T>({ value: reducerFn, default: () => T })
 *   reducerFn 用于合并多次写入，默认用后面的覆盖前面的
 * ================================================================
 */

import { Annotation } from "@langchain/langgraph";

/** 默认 reducer：后面的值覆盖前面的 */
function overide<T>(a: T, b: T): T {
  return b ?? a;
}

export const AgentState = Annotation.Root({
  // ========== 输入 ==========
  user_input: Annotation<string>(),
  docId: Annotation<string>(),
  doc_context: Annotation<string>(),

  // ========== 工作内存 ==========
  related_memory: Annotation<string>({ value: overide, default: () => "" }),
  analysis: Annotation<string>({ value: overide, default: () => "" }),
  plan: Annotation<string>({ value: overide, default: () => "" }),
  execution_log: Annotation<string>({ value: overide, default: () => "" }),
  validate_result: Annotation<string>({ value: overide, default: () => "" }),

  // ========== 控制字段 ==========
  retry_count: Annotation<number>({ value: overide, default: () => 0 }),
  max_retry: Annotation<number>({ value: overide, default: () => 3 }),
  retryable: Annotation<boolean>({ value: overide, default: () => true }),
  needs_user_input: Annotation<boolean>({ value: overide, default: () => false }),
  success: Annotation<boolean>({ value: overide, default: () => false }),
});
