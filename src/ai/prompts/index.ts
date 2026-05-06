/**
 * ================================================================
 * Prompts 统一导出
 * ================================================================
 * 所有阶段模板从这里引用，外部无需关心内部文件结构。
 * 拓展：新增阶段只需在此追加 export。
 */

// 共享规则
export { ANTI_LEAK_RULES, CLASSIFICATION_RULES, EXECUTION_STYLE_RULES, LANGUAGE_RULES } from "./shared/rules";
export { CLASSIFICATION_EXAMPLES, EXECUTION_STYLE_EXAMPLES } from "./shared/examples";

// 各阶段模板 + 工厂函数（改进项 7）
export {
  analyzeThoughtPrompt,
  analyzeToolPrompt,
  buildAnalyzePhase,
} from "./analyze";
export type { AnalyzePhaseParams } from "./analyze";

export {
  planThoughtPrompt,
  planToolPrompt,
  buildPlanPhase,
} from "./plan";
export type { PlanPhaseParams } from "./plan";

export { executeSystemPrompt, buildToolList } from "./execute";

export {
  validateThoughtPrompt,
  validateToolPrompt,
  buildValidatePhase,
} from "./validate";
export type { ValidatePhaseParams } from "./validate";

export { generateSystemPrompt } from "./generate";
export { chatSystemPrompt } from "./chat";
