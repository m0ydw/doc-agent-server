/**
 * DeepSeek LLM 包装器 - 使用 axios 直接调用（带重试机制）
 */

import axios from "axios";
import { LLM, LLMResponse } from "../llm";

export interface DeepSeekConfig {
  apiKey: string;
  modelName?: string;
  temperature?: number;
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 基础延迟 ms（默认 1000） */
  baseDelay?: number;
}

const BASE_URL = "https://api.deepseek.com";

/**
 * 指数退避重试辅助函数
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status;
      // 只对 429 或 5xx 重试
      if (attempt === maxRetries || (status !== 429 && !(status >= 500 && status < 600))) {
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`[DeepSeek] 请求失败 (${status})，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export class DeepSeekImpl implements LLM {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private maxRetries: number;
  private baseDelay: number;

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey;
    this.model = config.modelName || "deepseek-chat";
    this.temperature = config.temperature ?? 0.1;
    this.maxRetries = config.maxRetries ?? 3;
    this.baseDelay = config.baseDelay ?? 1000;

    console.log("[DeepSeek] 客户端初始化完成, model:", this.model);
  }

  // 构建请求头
  private getHeaders() {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  // 非流式调用（带重试）
  async invoke(messages: any[]): Promise<LLMResponse> {
    const deepseekMessages = this.convertMessages(messages);

    try {
      const response = await withRetry(async () => {
        const res = await axios.post(
          `${BASE_URL}/v1/chat/completions`,
          {
            model: this.model,
            messages: deepseekMessages,
            temperature: this.temperature,
            stream: false,
          },
          {
            headers: this.getHeaders(),
            timeout: 60000,
          }
        );
        return res.data;
      }, this.maxRetries, this.baseDelay);

      if (!response.choices || response.choices.length === 0) {
        throw new Error("API 返回空的 choices");
      }

      const content = response.choices[0].message.content;
      console.log("[DeepSeek] 响应成功, length:", content?.length ?? 0);
      return { content: content ?? "" };

    } catch (error: any) {
      const errMsg = error?.response?.data?.error?.message || error.message || "未知错误";
      console.error("[DeepSeek] 调用失败:", error?.response?.status, errMsg);
      throw new Error(`DeepSeek 调用失败: ${errMsg}`);
    }
  }

  // 流式调用（带重试）
  async *stream(messages: any[]): AsyncGenerator<LLMResponse, void, unknown> {
    const deepseekMessages = this.convertMessages(messages);
    let content = "";

    const attemptStream = async () => {
      const response = await axios.post(
        `${BASE_URL}/v1/chat/completions`,
        {
          model: this.model,
          messages: deepseekMessages,
          temperature: this.temperature,
          stream: true,
        },
        {
          headers: {
            ...this.getHeaders(),
            "Accept": "text/event-stream",
          },
          responseType: "stream",
          timeout: 120000,
        }
      );
      return response.data;
    };

    let stream: any;
    try {
      stream = await withRetry(() => attemptStream(), this.maxRetries, this.baseDelay);
    } catch (error: any) {
      const errMsg = error?.response?.data?.error?.message || error.message || "未知错误";
      throw new Error(`DeepSeek 流式连接失败: ${errMsg}`);
    }

    // 处理 SSE 流
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += chunk.toString();
        
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            return;
          }
          
          try {
            const data = JSON.parse(dataStr);
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              content += delta;
              yield { content: delta };  // 返回增量而非累积
            }
          } catch (e) {
            // 解析失败，跳过
          }
        }
      }
    } catch (error: any) {
      throw new Error(`DeepSeek 流读取中断: ${error.message || "未知错误"}`);
    }
  }

  /**
   * 转换消息格式
   */
  private convertMessages(messages: any[]): { role: string; content: string }[] {
    return messages.map(msg => {
      if (typeof msg === "string") {
        return { role: "user", content: msg };
      }

      if (msg.role && typeof msg.content === "string") {
        return { role: msg.role, content: msg.content };
      }

      let role = "user";
      if (msg.role) {
        role = msg.role;
      } else if (msg._type) {
        const t = msg._type.toLowerCase();
        if (t === "human" || t === "user") role = "user";
        else if (t === "ai" || t === "assistant") role = "assistant";
        else if (t === "system") role = "system";
        else if (t === "function" || t === "tool") role = "tool";
      } else if (msg.type) {
        role = msg.type;
      }

      const content = msg.content || msg.text || msg.value || "";
      return { role, content };
    });
  }
}

export function createDeepSeek(config: DeepSeekConfig): LLM {
  return new DeepSeekImpl(config);
}