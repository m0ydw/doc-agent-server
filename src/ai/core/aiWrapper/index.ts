/**
 * LLM 包装器导出
 */

export { ZhipuAIImpl, createZhipuAI, ZhipuAIConfig } from "./zhipuAI";
export { DeepSeekImpl, createDeepSeek, DeepSeekConfig } from "./deepseek";

// 常用的 API Key 环境变量名暴露供外部使用
export const ENV_KEYS = {
  ZHIPUAI: "ZHIPUAI_API_KEY",
  DEEPSEEK: "DEEPSEEK_API_KEY",
} as const;