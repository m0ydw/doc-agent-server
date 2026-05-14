import { createLlmDecisionProvider } from "./llmDecisionProvider";
import {
  createLangChainDecisionClient,
  LlmDecisionClientAdapterError,
  type LangChainLikeLlm,
} from "./llmDecisionClientAdapter";
import { createInitialDocxToolAgentState } from "./state";
import { createSafeToolSet } from "./toolSets";

type HarnessStatus = "passed" | "failed";

interface LlmDecisionClientAdapterHarnessResult {
  name: string;
  status: HarnessStatus;
  detail: string;
}

export async function runLlmDecisionClientAdapterHarnessScenarios(): Promise<LlmDecisionClientAdapterHarnessResult[]> {
  const results: LlmDecisionClientAdapterHarnessResult[] = [];

  results.push(await testStringResponse());
  results.push(await testObjectContentString());
  results.push(await testArrayContentTextBlocks());
  results.push(await testArrayContentStringBlocks());
  results.push(await testEmptyContent());
  results.push(await testProviderThrows());
  results.push(await testInvalidPrompt());
  results.push(await testAbortBeforeCall());
  results.push(await testTimeout());
  results.push(await testNoFullPromptLogging());
  results.push(await testCreateLlmDecisionProviderCompatibility());

  return results;
}

async function testStringResponse(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm = createMockLlm("hello");
  const client = createLangChainDecisionClient(llm);
  const output = await client.complete("prompt");
  return result("string response", output === "hello", `output=${output}`);
}

async function testObjectContentString(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm = createMockLlm({ content: "{\"toolName\":\"finish\"}" });
  const client = createLangChainDecisionClient(llm);
  const output = await client.complete("prompt");
  return result(
    "object content string",
    output === "{\"toolName\":\"finish\"}",
    `output=${output}`
  );
}

async function testArrayContentTextBlocks(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm = createMockLlm({
    content: [
      { type: "text", text: "abc" },
      { type: "text", text: "def" },
    ],
  });
  const client = createLangChainDecisionClient(llm);
  const output = await client.complete("prompt");
  return result("array content text blocks", output === "abcdef", `output=${output}`);
}

async function testArrayContentStringBlocks(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm = createMockLlm({ content: ["abc", "def"] });
  const client = createLangChainDecisionClient(llm);
  const output = await client.complete("prompt");
  return result("array content string blocks", output === "abcdef", `output=${output}`);
}

async function testEmptyContent(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm = createMockLlm({ content: "" });
  const client = createLangChainDecisionClient(llm);
  const error = await captureError(() => client.complete("prompt"));
  return result(
    "empty content",
    isAdapterError(error, "LLM_DECISION_EMPTY_RESPONSE"),
    errorDetail(error)
  );
}

async function testProviderThrows(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm: LangChainLikeLlm = {
    async invoke(): Promise<string> {
      throw new Error("provider down");
    },
  };
  const client = createLangChainDecisionClient(llm);
  const error = await captureError(() => client.complete("prompt"));
  return result(
    "provider throws",
    isAdapterError(error, "LLM_DECISION_PROVIDER_ERROR"),
    errorDetail(error)
  );
}

async function testInvalidPrompt(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm = createMockLlm("unused");
  const client = createLangChainDecisionClient(llm);
  const error = await captureError(() => client.complete(""));
  return result(
    "invalid prompt",
    isAdapterError(error, "LLM_DECISION_INVALID_PROMPT"),
    errorDetail(error)
  );
}

async function testAbortBeforeCall(): Promise<LlmDecisionClientAdapterHarnessResult> {
  let invoked = false;
  const controller = new AbortController();
  controller.abort();
  const llm: LangChainLikeLlm = {
    async invoke(): Promise<string> {
      invoked = true;
      return "unused";
    },
  };
  const client = createLangChainDecisionClient(llm, { signal: controller.signal });
  const error = await captureError(() => client.complete("prompt"));
  return result(
    "abort before call",
    isAdapterError(error, "LLM_DECISION_ABORTED") && !invoked,
    `${errorDetail(error)}, invoked=${invoked}`
  );
}

async function testTimeout(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm: LangChainLikeLlm = {
    async invoke(): Promise<string> {
      return new Promise<string>(() => undefined);
    },
  };
  const client = createLangChainDecisionClient(llm, { timeoutMs: 5 });
  const error = await captureError(() => client.complete("prompt"));
  return result(
    "timeout",
    isAdapterError(error, "LLM_DECISION_TIMEOUT"),
    errorDetail(error)
  );
}

async function testNoFullPromptLogging(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const logEntries: unknown[][] = [];
  const secretPrompt = "prompt-with-secret-document-text";
  const llm = createMockLlm("ok");
  const client = createLangChainDecisionClient(llm, {
    debug: true,
    logger: {
      debug: (...args) => logEntries.push(args),
      warn: (...args) => logEntries.push(args),
      error: (...args) => logEntries.push(args),
    },
  });
  await client.complete(secretPrompt);
  const serialized = JSON.stringify(logEntries);
  return result(
    "no full prompt logging",
    !serialized.includes(secretPrompt) && serialized.includes("promptLength"),
    serialized
  );
}

async function testCreateLlmDecisionProviderCompatibility(): Promise<LlmDecisionClientAdapterHarnessResult> {
  const llm = createMockLlm(JSON.stringify({
    summary: "generate plan",
    observations: ["mock"],
    reason: "next safe planning step",
    toolName: "generate_fill_plan",
    args: {
      referenceDocId: "ref-doc",
      targetDocId: "target-doc",
    },
  }));
  const client = createLangChainDecisionClient(llm);
  const provider = createLlmDecisionProvider({
    client,
    availableTools: createSafeToolSet(),
    policy: "planning_only",
  });
  const decision = await provider(createInitialDocxToolAgentState({
    userInput: "fill docs",
    docId: "target-doc",
    referenceDocId: "ref-doc",
    targetDocId: "target-doc",
  }));
  return result(
    "createLlmDecisionProvider compatibility",
    decision.toolName === "generate_fill_plan",
    `toolName=${decision.toolName}`
  );
}

function createMockLlm(response: unknown): LangChainLikeLlm {
  return {
    async invoke(): Promise<any> {
      return response;
    },
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function isAdapterError(error: unknown, code: string): boolean {
  return error instanceof LlmDecisionClientAdapterError && error.code === code;
}

function errorDetail(error: unknown): string {
  if (error instanceof LlmDecisionClientAdapterError) {
    return `code=${error.code}`;
  }
  if (error instanceof Error) {
    return `error=${error.message}`;
  }
  return `error=${String(error)}`;
}

function result(
  name: string,
  passed: boolean,
  detail: string
): LlmDecisionClientAdapterHarnessResult {
  return {
    name,
    status: passed ? "passed" : "failed",
    detail,
  };
}
