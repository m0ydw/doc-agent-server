/**
 * Prompts 统一导出
 * - 保留旧版导出的向后兼容（供 globalAgent chat 模式使用）
 * - 新增多 Agent 架构 Prompt 导出
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
