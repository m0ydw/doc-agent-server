/**
 * ================================================================
 * LangGraph AgentState — 多 Agent 工作流共享内存
 *
 * 多 Agent 架构字段：
 *   - orchestrator: intent + agentPlan（委派计划）
 *   - docAnalyst: documentMaps（文档结构地图）
 *   - templateFiller: extractedData（用户数据）+ fieldMappings（字段映射表）
 *   - reviewer: diffReport（差异报告）
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
  /** Orchestrator 产出：意图 + agentPlan JSON */
  analysis: Annotation<string>({ value: override, default: () => "{}" }),
  /** Orchestrator 委派计划 JSON（替代旧 planJson） */
  planJson: Annotation<string>({ value: override, default: () => '{"agentPlan":[]}' }),
  cachedDocText: Annotation<string>({ value: override, default: () => "" }),
  executionLog: Annotation<string>({ value: override, default: () => "" }),

  // ========== 多 Agent 专有字段 ★新增★ ==========
  /** DataExtractor 提取的结构化用户数据 JSON */
  extractedData: Annotation<string>({ value: override, default: () => "{}" }),
  /** DocAnalyst 产出的文档结构地图 JSON */
  documentMaps: Annotation<string>({ value: override, default: () => "[]" }),
  /** TemplateFiller 产出的字段映射表 JSON */
  fieldMappings: Annotation<string>({ value: override, default: () => "[]" }),
  /** Reviewer 产出的差异报告 JSON */
  diffReport: Annotation<string>({ value: override, default: () => "{}" }),

  // ========== 验证结果 ==========
  validateJson: Annotation<string>({ value: override, default: () => "{}" }),

  // ========== 控制字段 ==========
  retryCount: Annotation<number>({ value: override, default: () => 0 }),
  maxRetry: Annotation<number>({ value: override, default: () => 3 }),
  success: Annotation<boolean>({ value: override, default: () => false }),
  retryable: Annotation<boolean>({ value: override, default: () => true }),
  needsUserInput: Annotation<boolean>({ value: override, default: () => false }),

  // ========== 委派步骤追踪 ★新增★ ==========
  /** 当前委派步骤索引（agentPlan 中的位置） */
  delegationStep: Annotation<number>({ value: override, default: () => 0 }),
  /** 上一步委派的 Agent 名称 */
  lastAgent: Annotation<string>({ value: override, default: () => "" }),

  // ========== Plan 校验（保留兼容） ==========
  planValid: Annotation<boolean>({ value: override, default: () => true }),
  planErrorContext: Annotation<string>({ value: override, default: () => "" }),
  planRetries: Annotation<number>({ value: override, default: () => 0 }),
});
