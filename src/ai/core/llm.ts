/**
 * LLM 接口定义
 */

import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";

export interface LLMResponse {
  content: string;
}

export interface LLM {
  invoke(messages: Array<HumanMessage | SystemMessage | AIMessage>): Promise<LLMResponse>;
  stream(messages: Array<HumanMessage | SystemMessage | AIMessage>): AsyncGenerator<LLMResponse, void, unknown>;
}

export interface LLMMessage {
  text: string;
  role: "user" | "assistant" | "system";
}

export function createMessages(messages: Array<LLMMessage>) {
  return messages.map(function(msg) {
    switch (msg.role) {
      case "user": return new HumanMessage(msg.text);
      case "assistant": return new AIMessage(msg.text);
      case "system": return new SystemMessage(msg.text);
      default: return new HumanMessage(msg.text);
    }
  });
}

export async function* createStream(asyncIterable: AsyncIterable<string>): AsyncGenerator<LLMResponse, void, unknown> {
  var content = "";
  for await (var chunk of asyncIterable) {
    content += chunk;
    yield { content: content };
  }
}