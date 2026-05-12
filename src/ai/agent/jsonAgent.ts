/**
 * JSONAgent — 独立的 JSON 调用代理
 *
 * 职责：接收 System/Human prompt → 创建临时 ChatOpenAI（带 JSON mode）→
 * 调用 → 清理 markdown → JSON.parse → 返回对象。
 *
 * 【设计动机】
 * 工作流中的 orchestrator、docAnalyst、reviewer 等节点需要 LLM 返回
 * 结构化的 JSON 数据（意图分析、文档分析、验证报告），而不是自由文本。
 * 通过在 modelKwargs 中设置 response_format: { type: "json_object" }，
 * 确保 LLM 输出合法的 JSON。
 *
 * 【与 GlobalAgent 的区别】
 * - GlobalAgent: 维护单一 LLM 实例，用于 Chat 模式的流式对话
 * - JSONAgent:  为每次调用创建独立的临时 LLM 实例（带 JSON mode），
 *   不依赖原 llm 实例的内部字段，自己管理 provider、apiKey、baseURL
 *
 * 【在整体流程中的位置】
 * 被 workflow 的 orchestrator、docAnalyst、reviewer 等节点调用，
 * 每次调用都创建一个新的 ChatOpenAI 实例，调用完毕后释放。
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { PROVIDER_CONFIG, type LLMProvider } from "../core/llm";
import { extractAndParseJson } from "../core/jsonExtractor";

/**
 * JSONAgent 类 — 每次调用创建独立的 ChatOpenAI 实例
 *
 * 工作流节点通过此类获取结构化的 JSON 输出。
 * 每次 call() 创建一个新的 ChatOpenAI 实例，设置 response_format 为 json_object。
 */
export class JSONAgent {
  /** LLM 厂商 */
  private provider: LLMProvider;
  /** API Key */
  private apiKey: string;
  /** 模型名称 */
  private model: string;

  /**
   * 构造函数
   * @param provider LLM 厂商标识
   * @param apiKey  API Key
   * @param model   模型名称（可选，不传则使用厂商默认）
   */
  constructor(provider: LLMProvider, apiKey: string, model?: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model || PROVIDER_CONFIG[provider].defaultModel;
  }

  /**
   * 调用 LLM 并返回 JSON 对象
   *
   * 【调用流程】
   * 1. 创建临时 ChatOpenAI 实例，设置 response_format 为 json_object（强制 JSON 输出）
   * 2. 传入 SystemMessage + HumanMessage
   * 3. 从响应中提取文本内容
   * 4. 先清理 markdown 代码块标记，然后 JSON.parse
   * 5. 如果直接 parse 失败，使用 extractAndParseJson 进行降级提取
   *
   * 【为什么每次 call() 创建新的 LLM 实例？】
   * 确保 response_format 隔离：不同调用模式（JSON/流式/普通）需要不同的 modelKwargs。
   * 临时创建避免了与其他调用者的参数冲突。
   *
   * @param systemPrompt SystemMessage 内容（定义输出格式和任务要求）
   * @param userPrompt   HumanMessage 内容（实际的输入数据）
   * @returns JSON.parse 成功的对象；调用或解析失败时返回 null
   */
  async call(systemPrompt: string, userPrompt: string): Promise<Record<string, any> | null> {
    const cfg = PROVIDER_CONFIG[this.provider];

    // 创建临时 ChatOpenAI 实例（JSON mode）
    const llm = new ChatOpenAI({
      apiKey: this.apiKey,
      model: this.model,
      temperature: 0.1,
      configuration: { baseURL: cfg.baseURL },
      modelKwargs: { response_format: { type: "json_object" } },
    });

    console.log("[JSONAgent] 调用 model=" + this.model + " provider=" + this.provider);

    try {
      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      const raw = typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

      console.log("[JSONAgent] 原始响应(len=" + raw.length + "):", raw.slice(0, 200));

      // 清理 markdown 代码块包裹（```json ... ```）
      const cleaned = raw
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();

      try {
        // 第一次尝试：直接 JSON.parse
        return JSON.parse(cleaned);
      } catch (e1) {
        // 降级：使用括号计数的安全提取（替代贪婪正则 /\{[\s\S]*\}/）
        const extracted = extractAndParseJson(cleaned);
        if (extracted) return extracted;
        console.warn("[JSONAgent] JSON 提取失败, cleaned_head=" + cleaned.slice(0, 120));
        return null;
      }
    } catch (e: any) {
      console.warn("[JSONAgent] API 调用失败:", e.message?.slice(0, 200));
      return null;
    }
  }
}
