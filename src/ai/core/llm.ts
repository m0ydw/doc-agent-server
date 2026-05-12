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

// 重新导出 LangChain 标准消息类型，方便其他模块直接从此文件导入
export type { BaseMessage, HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";

import { ChatOpenAI } from "@langchain/openai";

/**
 * 支持的 LLM 厂商标识
 * - "zhipu": 智谱AI (GLM-4 系列)
 * - "deepseek": DeepSeek
 * - "openai": OpenAI
 */
export type LLMProvider = "zhipu" | "deepseek" | "openai";

/**
 * 创建 ChatModel 的配置参数
 *
 * 这是创建 LLM 实例的统一入口配置，屏蔽了不同厂商的底层差异。
 * 所有 LLM 实例都通过 createChatModel() 函数创建。
 */
export interface LLMConfig {
  /** 厂商名（zhipu / deepseek / openai） */
  provider: LLMProvider;
  /** API Key */
  apiKey: string;
  /** 模型名（可选，不指定则使用厂商默认模型） */
  modelName?: string;
  /** 温度参数（0-2，默认 0.1），越低输出越确定，越高越有创意 */
  temperature?: number;
  /** 额外 modelKwargs（如 deepseek-v4 需要 special tokens 配置） */
  modelKwargs?: Record<string, any>;
}

/**
 * 各厂商的 baseURL 和默认模型映射
 *
 * baseURL 是 OpenAI 兼容 API 的根地址，ChatOpenAI 通过 configuration.baseURL 切换厂商。
 * 所有厂商都使用 OpenAI 的 Chat Completions API 格式。
 */
export const PROVIDER_CONFIG: Record<LLMProvider, { baseURL: string; defaultModel: string }> = {
  /** 智谱AI GLM-4 系列 */
  zhipu: {
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
  },
  /** DeepSeek 通用对话模型 */
  deepseek: {
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
  },
  /** OpenAI（标准 baseURL，也可用于兼容 OpenAI API 的第三方代理） */
  openai: {
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
};

/**
 * 创建 LangChain ChatOpenAI 实例（统一工厂函数）
 *
 * 这是整个系统中创建 LLM 实例的唯一入口，所有 Agent 和 Workflow 节点都通过此函数获取 LLM。
 *
 * 【特殊处理】
 * - DeepSeek: 默认的 thinking mode 在 Tool Calling 场景下会报 reasoning_content 错误，
 *   因此通过 modelKwargs.thinking = { type: "disabled" } 主动禁用思考模式。
 * - 超时时间设为 120 秒（2 分钟），避免长时间无响应挂起。
 * - 温度默认 0.1，适合文档编辑（需要确定性输出而非创意输出）。
 *
 * @param config.provider - 厂商名（zhipu / deepseek / openai）
 * @param config.apiKey   - API Key
 * @param config.modelName - 模型名（可选，默认使用厂商推荐模型）
 * @param config.temperature - 温度参数（默认 0.1）
 * @param config.modelKwargs - 额外参数（如 deepseek-v4 特殊配置）
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

  const modelKwargs: Record<string, any> = { ...(config.modelKwargs || {}) };

  // DeepSeek: 默认 thinking mode 在 tool calling 中会报 reasoning_content 错误，需禁用
  if (config.provider === "deepseek" && !modelKwargs.hasOwnProperty("thinking")) {
    modelKwargs.thinking = { type: "disabled" };
  }

  return new ChatOpenAI({
    apiKey: config.apiKey,
    model,
    temperature: config.temperature ?? 0.1,
    timeout: 120000, // 2 分钟超时（行业标准）
    configuration: { baseURL: providerCfg.baseURL },
    modelKwargs: Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined,
  });
}

/**
 * 从环境变量推断 LLM 厂商并创建 ChatModel（零配置启动）
 *
 * 按优先级依次检查环境变量：
 * 1. ZHIPUAI_API_KEY → 创建智谱AI LLM 实例
 * 2. DEEPSEEK_API_KEY → 创建 DeepSeek LLM 实例
 * 3. OPENAI_API_KEY   → 创建 OpenAI LLM 实例
 *
 * 如果三者都未设置，返回 null。
 * 此函数用于服务器启动时的自动初始化，用户无需在配置文件中指定厂商。
 *
 * @returns ChatOpenAI 实例或 null（无可用 API Key 时）
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
