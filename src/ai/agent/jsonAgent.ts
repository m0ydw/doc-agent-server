/**
 * JSONAgent — 独立的 JSON 调用代理
 *
 * 职责：接收 System/Human prompt → 创建临时 ChatOpenAI（带 JSON mode）→
 * 调用 → 清理 markdown → JSON.parse → 返回对象。
 *
 * 优势：不依赖原 llm 实例的内部字段（client/apiKey 等），
 * 自己管理 provider、apiKey、baseURL，确保 modelKwargs 生效。
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { PROVIDER_CONFIG, type LLMProvider } from "../core/llm";

export class JSONAgent {
  private provider: LLMProvider;
  private apiKey: string;
  private model: string;

  constructor(provider: LLMProvider, apiKey: string, model?: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model || PROVIDER_CONFIG[provider].defaultModel;
  }

  /**
   * 调用 LLM 并返回 JSON 对象
   *
   * @param systemPrompt - SystemMessage 内容
   * @param userPrompt   - HumanMessage 内容
   * @returns JSON.parse 成功的对象；失败时返回 null
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

      // 清理 markdown 包裹
      const cleaned = raw
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();

      try {
        return JSON.parse(cleaned);
      } catch (e1) {
        // 尝试提取大括号 JSON
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          try { return JSON.parse(match[0]); } catch { /* ignore */ }
        }
        console.warn("[JSONAgent] JSON.parse 失败, cleaned_head=" + cleaned.slice(0, 120));
        return null;
      }
    } catch (e: any) {
      console.warn("[JSONAgent] API 调用失败:", e.message?.slice(0, 200));
      return null;
    }
  }
}
