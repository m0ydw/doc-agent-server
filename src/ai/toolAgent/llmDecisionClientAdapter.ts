import type { LlmDecisionClient } from "./llmDecisionProvider";

export type LangChainLikeMessageContent =
  | string
  | Array<string | { type?: string; text?: string }>
  | unknown;

export interface LangChainLikeResponse {
  content?: LangChainLikeMessageContent;
}

export interface LangChainLikeLlm {
  invoke(input: unknown, options?: unknown): Promise<LangChainLikeResponse | string>;
}

export interface LlmDecisionClientAdapterOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  debug?: boolean;
  logger?: {
    debug?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

export type LlmDecisionClientAdapterErrorCode =
  | "LLM_DECISION_TIMEOUT"
  | "LLM_DECISION_ABORTED"
  | "LLM_DECISION_PROVIDER_ERROR"
  | "LLM_DECISION_EMPTY_RESPONSE"
  | "LLM_DECISION_INVALID_PROMPT";

export class LlmDecisionClientAdapterError extends Error {
  readonly code: LlmDecisionClientAdapterErrorCode;
  readonly details?: unknown;

  constructor(
    code: LlmDecisionClientAdapterErrorCode,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "LlmDecisionClientAdapterError";
    this.code = code;
    this.details = details;
  }
}

export function createLangChainDecisionClient(
  llm: LangChainLikeLlm,
  options: LlmDecisionClientAdapterOptions = {}
): LlmDecisionClient {
  return {
    async complete(prompt: string): Promise<string> {
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new LlmDecisionClientAdapterError(
          "LLM_DECISION_INVALID_PROMPT",
          "Prompt must be a non-empty string."
        );
      }

      assertNotAborted(options.signal);
      logDebug(options, "llm_decision_complete_start", { promptLength: prompt.length });

      try {
        const response = await invokeWithTimeout(
          llm,
          prompt,
          options
        );
        assertNotAborted(options.signal);

        const text = responseToText(response);
        if (!text.trim()) {
          throw new LlmDecisionClientAdapterError(
            "LLM_DECISION_EMPTY_RESPONSE",
            "LLM response did not contain text."
          );
        }

        logDebug(options, "llm_decision_complete_success", { responseLength: text.length });
        return text;
      } catch (error) {
        if (error instanceof LlmDecisionClientAdapterError) {
          logWarn(options, "llm_decision_complete_failed", { code: error.code });
          throw error;
        }
        logWarn(options, "llm_decision_complete_failed", { code: "LLM_DECISION_PROVIDER_ERROR" });
        throw new LlmDecisionClientAdapterError(
          "LLM_DECISION_PROVIDER_ERROR",
          error instanceof Error ? error.message : "LLM provider failed.",
          sanitizeErrorDetails(error)
        );
      }
    },
  };
}

async function invokeWithTimeout(
  llm: LangChainLikeLlm,
  prompt: string,
  options: LlmDecisionClientAdapterOptions
): Promise<LangChainLikeResponse | string> {
  const input = [{ role: "user", content: prompt }];
  const invokeOptions = options.signal ? { signal: options.signal } : undefined;
  const invokePromise = llm.invoke(input, invokeOptions);

  if (!options.timeoutMs || options.timeoutMs <= 0) {
    return invokePromise;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new LlmDecisionClientAdapterError(
        "LLM_DECISION_TIMEOUT",
        `LLM decision request timed out after ${options.timeoutMs}ms.`
      ));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([invokePromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function responseToText(response: LangChainLikeResponse | string): string {
  if (typeof response === "string") {
    return response;
  }
  if (!response || typeof response !== "object" || !("content" in response)) {
    return "";
  }
  return contentToText((response as LangChainLikeResponse).content);
}

function contentToText(content: LangChainLikeMessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    }).join("");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }
  return "";
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LlmDecisionClientAdapterError(
      "LLM_DECISION_ABORTED",
      "LLM decision request was aborted."
    );
  }
}

function sanitizeErrorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return undefined;
}

function logDebug(
  options: LlmDecisionClientAdapterOptions,
  message: string,
  details: Record<string, unknown>
): void {
  if (options.debug) {
    options.logger?.debug?.(message, details);
  }
}

function logWarn(
  options: LlmDecisionClientAdapterOptions,
  message: string,
  details: Record<string, unknown>
): void {
  if (options.debug) {
    options.logger?.warn?.(message, details);
  }
}
