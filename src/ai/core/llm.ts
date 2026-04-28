/**
 * ================================================================
 * LLM 模块 — LangChain ChatOpenAI 统一工厂
 * ================================================================
 *
 * 【为什么用 ChatOpenAI + baseURL？】
 * DeepSeek 和智谱AI 都兼容 OpenAI 的 Chat Completions API 格式，
 * 因此统一使用 @langchain/openai 的 ChatOpenAI，通过 baseURL 切换厂商。
 * 这样规避了手写 axios + SSE 流式解析 + 指数退避重试的重复代码，
 * 直接获得 LangChain 标准化的 invoke()/stream()/batch() 接口。
 *
 * 【厂商切换示例】
 *   createChatModel({ provider: "zhipu",    apiKey: "xxx" })  → glm-4-flash
 *   createChatModel({ provider: "deepseek", apiKey: "xxx" })  → deepseek-chat
 *   createChatModel({ provider: "openai",   apiKey: "xxx" })  → gpt-4o-mini
 *
 * 【流式调用】
 *   const stream = await model.stream([...messages]);
 *   for await (const chunk of stream) {
 *     console.log(chunk.content);  // 逐 token 输出
 *   }
 *
 * 【与旧版区别】
 *   旧版: 手写 axios.post() → SSE 解析 → 重试逻辑 → 消息格式转换（~200行/厂商）
 *   新版: new ChatOpenAI({ configuration: { baseURL } })  （~10行）
 * ================================================================
 */

export type { BaseMessage, HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";

import { ChatOpenAI } from "@langchain/openai";

/** 支持的 LLM 厂商 */
export type LLMProvider = "zhipu" | "deepseek" | "openai";

/** 创建 ChatModel 的配置参数 */
export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  modelName?: string;
  temperature?: number;
}

/** 各厂商的 baseURL 和默认模型映射 */
export const PROVIDER_CONFIG: Record<LLMProvider, { baseURL: string; defaultModel: string }> = {
  zhipu: {
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
};

/**
 * 创建 LangChain ChatOpenAI 实例
 *
 * @param config.provider - 厂商名（zhipu / deepseek / openai）
 * @param config.apiKey   - API Key
 * @param config.modelName - 模型名（可选，默认使用厂商推荐模型）
 * @param config.temperature - 温度参数（默认 0.1）
 * @returns ChatOpenAI 实例
 *
 * 【调用示例】
 *   const model = createChatModel({
 *     provider: "zhipu",
 *     apiKey: process.env.ZHIPUAI_API_KEY!,
 *   });
 *   const response = await model.invoke([new HumanMessage("你好")]);
 */
export function createChatModel(config: LLMConfig): ChatOpenAI {
  const providerCfg = PROVIDER_CONFIG[config.provider];
  const model = config.modelName || providerCfg.defaultModel;

  const modelKwargs: Record<string, any> = {};

  // DeepSeek: 默认 thinking mode 在 tool calling 中会报 reasoning_content 错误，需禁用
  if (config.provider === "deepseek") {
    modelKwargs.thinking = { type: "disabled" };
  }

  return new ChatOpenAI({
    apiKey: config.apiKey,
    model,
    temperature: config.temperature ?? 0.1,
    configuration: { baseURL: providerCfg.baseURL },
    modelKwargs: Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined,
  });
}

/**
 * 从环境变量推断 LLM 厂商并创建 ChatModel
 * 优先使用 ZHIPUAI_API_KEY，其次 DEEPSEEK_API_KEY
 */
export function createChatModelFromEnv(): ChatOpenAI | null {
  const zhipuKey = process.env.ZHIPUAI_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (zhipuKey) {
    return createChatModel({ provider: "zhipu", apiKey: zhipuKey });
  }
  if (deepseekKey) {
    return createChatModel({ provider: "deepseek", apiKey: deepseekKey });
  }
  if (openaiKey) {
    return createChatModel({ provider: "openai", apiKey: openaiKey });
  }
  return null;
}
