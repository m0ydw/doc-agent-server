/**
 * Prompts 统一导出 — 所有 Prompt 模板的集中入口
 *
 * 【模块结构】
 * - shared/: 所有阶段共享的规则（防泄露、意图分类、执行风格、语言规则）和示例
 * - analyze.ts: 旧版 Analyze 阶段（意图分析）
 * - plan.ts:     旧版 Plan 阶段（任务规划）
 * - execute.ts:  旧版 Execute 阶段（执行 Prompt）
 * - validate.ts: 旧版 Validate 阶段（验证 Prompt）
 * - generate.ts: 旧版 Generate 阶段（生成最终回答）
 * - chat.ts:     Chat 模式 Prompt（文档问答）
 * - orchestrator.ts: 多Agent架构新 Prompt（总调度节点）
 *
 * 【使用说明】
 * - 旧版 Prompt（analyze/plan/execute/validate/generate）供 GlobalAgent 的
 *   非 Workflow 模式使用（向后兼容）
 * - chatSystemPrompt 供 GlobalAgent.runChatMode 使用
 * - orchestratorSystemPrompt + orchestratorHumanTemplate 供 workflow orchestrator 节点使用
 */

// 共享规则（所有阶段通用）
export { ANTI_LEAK_RULES, CLASSIFICATION_RULES, EXECUTION_STYLE_RULES, LANGUAGE_RULES } from "./shared/rules";
export { CLASSIFICATION_EXAMPLES, EXECUTION_STYLE_EXAMPLES } from "./shared/examples";

// 旧版 Prompt（chat 模式及其他兼容用途）
export { analyzeThoughtPrompt, analyzeToolPrompt, buildAnalyzePhase } from "./analyze";
export type { AnalyzePhaseParams } from "./analyze";
export { planThoughtPrompt, planToolPrompt, buildPlanPhase } from "./plan";
export type { PlanPhaseParams } from "./plan";
export { executeSystemPrompt, buildToolList } from "./execute";
export { validateThoughtPrompt, validateToolPrompt, buildValidatePhase } from "./validate";
export type { ValidatePhaseParams } from "./validate";
export { generateSystemPrompt } from "./generate";
export { chatSystemPrompt } from "./chat";

// ★ 新增：多 Agent 架构 Prompt
export { orchestratorSystemPrompt, orchestratorHumanTemplate } from "./orchestrator";
