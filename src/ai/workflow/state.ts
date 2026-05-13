/**
 * ================================================================
 * LangGraph AgentState — 多 Agent 工作流共享内存
 * ================================================================
 *
 * AgentState 是 LangGraph 工作流中各节点之间传递数据的共享状态容器。
 * 所有节点读取/写入此状态，每个节点返回 partial state 更新。
 *
 * 【重要设计原则】
 * - SemanticDocumentSchema 是唯一真相源
 * - 大型结构只存 ID，实际数据存储在外部
 * - delegationStep 必须正确推进
 */

import { Annotation } from "@langchain/langgraph";

/**
 * 默认 reducer：后值覆盖前值
 */
function override<T>(_a: T, b: T): T {
  return b;
}

function appendLog(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}\n${b}`;
}

/**
 * LangGraph Annotation.Root — 定义工作流共享状态的所有字段
 */
export const AgentState = Annotation.Root({
  // ========== 输入字段 ==========
  /** 用户的自然语言输入（原始文本） */
  userInput: Annotation<string>(),
  /** 目标文档 ID */
  docId: Annotation<string>(),
  referenceDocId: Annotation<string>({ value: override, default: () => "" }),
  targetDocId: Annotation<string>({ value: override, default: () => "" }),
  /** 文档的上下文描述（文件名、大小等元信息） */
  docContext: Annotation<string>({ value: override, default: () => "" }),
  /** 目标文档的原始文件名（如 "合同.docx"） */
  targetDocName: Annotation<string>({ value: override, default: () => "" }),

  // ========== Orchestrator 输出 ==========
  /** Orchestrator 产出：意图分析结果（JSON 字符串） */
  analysis: Annotation<string>({ value: override, default: () => "{}" }),
  /** Orchestrator 产出：委派计划 JSON（agentPlan 数组） */
  planJson: Annotation<string>({
    value: override,
    default: () => '{"agentPlan":[]}',
  }),
  /** DataExtractor 提取的结构化用户数据 JSON */
  extractedData: Annotation<string>({ value: override, default: () => "{}" }),

  // ========== DocAnalyst 输出 ==========
  /** 分析工件 ID（大型结构存外部） */
  analysisArtifactsId: Annotation<string>({ value: override, default: () => "" }),
  /** 语义文档 Schema ID（唯一真相源） */
  semanticSchemaId: Annotation<string>({ value: override, default: () => "" }),
  tableAnalysisId: Annotation<string>({ value: override, default: () => "" }),

  // ========== ExecutionPlanner 输出 ==========
  /** 执行计划 ID */
  executionPlanId: Annotation<string>({ value: override, default: () => "" }),
  /** 执行计划 JSON */
  executionPlan: Annotation<string>({ value: override, default: () => "{}" }),

  // ========== DocumentFiller 输出 ==========
  /** 事务 ID */
  transactionId: Annotation<string>({ value: override, default: () => "" }),
  /** 事务 JSON */
  transaction: Annotation<string>({ value: override, default: () => "{}" }),

  // ========== 控制字段 ==========
  /** 当前重试次数（0-based） */
  retryCount: Annotation<number>({ value: override, default: () => 0 }),
  /** 最大允许重试次数（默认 3） */
  maxRetry: Annotation<number>({ value: override, default: () => 3 }),
  /** 总体任务是否成功 */
  success: Annotation<boolean>({ value: override, default: () => false }),
  /** 当前任务是否可重试 */
  retryable: Annotation<boolean>({ value: override, default: () => true }),
  /** 是否需要等待用户提供更多输入 */
  needsUserInput: Annotation<boolean>({
    value: override,
    default: () => false,
  }),
  workflowError: Annotation<string>({ value: override, default: () => "" }),

  // ========== 委派步骤追踪 ==========
  /** 当前委派步骤索引（agentPlan 数组中的位置），每个节点执行后自增 */
  delegationStep: Annotation<number>({
    value: override,
    default: () => 0,
  }),
  /** 上一步执行的 Agent 名称 */
  lastAgent: Annotation<string>({ value: override, default: () => "" }),

  // ========== 日志 ==========
  /** 执行日志（字符串拼接，每个节点追加自身日志） */
  executionLog: Annotation<string>({ value: appendLog, default: () => "" }),
});
