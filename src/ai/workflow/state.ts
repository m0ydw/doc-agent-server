/**
 * ================================================================
 * LangGraph AgentState — 工作流共享内存
 * ================================================================
 */

import { Annotation } from "@langchain/langgraph";

/** 默认 reducer：后值覆盖前值 */
function override<T>(_a: T, b: T): T { return b; }

export const AgentState = Annotation.Root({

  // ========== 输入字段 ==========
  userInput: Annotation<string>(),
  docId: Annotation<string>(),
  docContext: Annotation<string>({ value: override, default: () => "" }),
  targetDocName: Annotation<string>({ value: override, default: () => "" }),

  // ========== 工作内存 ==========
  relatedMemory: Annotation<string>({ value: override, default: () => "" }),
  analysis: Annotation<string>({ value: override, default: () => "{}" }),
  planJson: Annotation<string>({ value: override, default: () => '{"tasks":[]}' }),
  cachedDocText: Annotation<string>({ value: override, default: () => "" }),
  executionLog: Annotation<string>({ value: override, default: () => "" }),

  // ========== 验证结果 ==========
  validateJson: Annotation<string>({ value: override, default: () => "{}" }),

  // ========== 控制字段 ==========
  retryCount: Annotation<number>({ value: override, default: () => 0 }),
  maxRetry: Annotation<number>({ value: override, default: () => 3 }),
  success: Annotation<boolean>({ value: override, default: () => false }),
  retryable: Annotation<boolean>({ value: override, default: () => true }),
  needsUserInput: Annotation<boolean>({ value: override, default: () => false }),
});
