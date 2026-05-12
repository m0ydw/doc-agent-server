/**
 * ================================================================
 * LangGraph AgentState — 多 Agent 工作流共享内存
 *
 * AgentState 是 LangGraph 工作流中各节点之间传递数据的共享状态容器。
 * 所有节点读取/写入此状态，每个节点返回 partial state 更新。
 *
 * 【多 Agent 架构字段】
 *   - orchestrator: intent + agentPlan（委派计划）
 *   - docAnalyst:    documentMaps（文档结构地图）
 *   - templateFiller: extractedData（用户数据）+ fieldMappings（字段映射表）
 *   - reviewer:      diffReport（差异报告）
 *
 * 【Reducer 说明】
 *   所有字段使用 default override reducer（后值覆盖前值），
 *   即节点返回的字段直接替换旧值，不做合并或追加。
 *   只有 executionLog 采用追加方式（字符串拼接），以保留完整日志链。
 *
 * 【字段分类】
 *   - 输入字段：用户输入、文档ID、文档上下文
 *   - 工作内存：分析结果、委派计划、缓存文本
 *   - 多Agent专有：数据提取、文档分析、字段映射、差异报告
 *   - 控制字段：重试计数、最大重试、成功标志
 *   - 委派追踪：当前步骤索引、上一个Agent名称
 *   - 校验保留：plan 校验相关（向后兼容）
 * ================================================================
 */

import { Annotation } from "@langchain/langgraph";

/**
 * 默认 reducer：后值覆盖前值
 * LangGraph 在每个节点返回 partial state 后调用此 reducer 合并
 */
function override<T>(_a: T, b: T): T { return b; }

/**
 * LangGraph Annotation.Root — 定义工作流共享状态的所有字段
 *
 * 每个字段由 Annotation<T>(options) 定义，options 包括：
 * - value: reducer 函数
 * - default: 默认值（生成器函数）
 */
export const AgentState = Annotation.Root({

  // ========== 输入字段 ==========
  /** 用户的自然语言输入（原始文本） */
  userInput: Annotation<string>(),
  /** 目标文档 ID */
  docId: Annotation<string>(),
  /** 文档的上下文描述（文件名、大小等元信息） */
  docContext: Annotation<string>({ value: override, default: () => "" }),
  /** 目标文档的原始文件名（如 "合同.docx"） */
  targetDocName: Annotation<string>({ value: override, default: () => "" }),

  // ========== 工作内存 ==========
  /** 从记忆库中检索到的相关历史记录 */
  relatedMemory: Annotation<string>({ value: override, default: () => "" }),
  /** Orchestrator 产出：意图分析结果（JSON 字符串，包含 intent + taskType） */
  analysis: Annotation<string>({ value: override, default: () => "{}" }),
  /** Orchestrator 产出：委派计划 JSON（agentPlan 数组） */
  planJson: Annotation<string>({ value: override, default: () => '{"agentPlan":[]}' }),
  /** 缓存的文档纯文本内容（避免重复读取 SDK） */
  cachedDocText: Annotation<string>({ value: override, default: () => "" }),
  /** 执行日志（字符串拼接，每个节点追加自身日志） */
  executionLog: Annotation<string>({ value: override, default: () => "" }),

  // ========== 多 Agent 专有字段 ★新增★ ==========
  /** DataExtractor 提取的结构化用户数据 JSON（格式：{ "字段名": "值" }） */
  extractedData: Annotation<string>({ value: override, default: () => "{}" }),
  /** DocAnalyst 产出的文档结构地图 JSON（数组，包含 tables、cells、labels 等） */
  documentMaps: Annotation<string>({ value: override, default: () => "[]" }),
  /** TemplateFiller 产出的字段映射表 JSON（数组，包含 fieldName、userValue、status 等） */
  fieldMappings: Annotation<string>({ value: override, default: () => "[]" }),
  /** Reviewer 产出的差异报告 JSON（包含 result、details、summary 等） */
  diffReport: Annotation<string>({ value: override, default: () => "{}" }),

  // ========== 验证结果（旧版兼容）==========
  /** 旧版验证结果 JSON */
  validateJson: Annotation<string>({ value: override, default: () => "{}" }),

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
  needsUserInput: Annotation<boolean>({ value: override, default: () => false }),

  // ========== 委派步骤追踪 ★新增★ ==========
  /** 当前委派步骤索引（agentPlan 数组中的位置），每个节点执行后自增 */
  delegationStep: Annotation<number>({ value: override, default: () => 0 }),
  /** 上一步执行的 Agent 名称（用于 wsAgentHandler 日志） */
  lastAgent: Annotation<string>({ value: override, default: () => "" }),

  // ========== Plan 校验字段（保留向后兼容）==========
  /** Plan 是否通过校验 */
  planValid: Annotation<boolean>({ value: override, default: () => true }),
  /** Plan 校验失败时的错误上下文 */
  planErrorContext: Annotation<string>({ value: override, default: () => "" }),
  /** Plan 重试次数 */
  planRetries: Annotation<number>({ value: override, default: () => 0 }),
});
