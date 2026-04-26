/**
 * 验证工具 - 验证执行结果
 */

import { LLM } from "../core/llm";

export interface ValidateState {
  execution_log: string;
}

export interface ValidateResult {
  result: string;
  thought: string;
}

var systemPrompt = "你是一个文档处理助手，负责验证执行结果是否正确。请检查执行日志并给出验证结论。\n\n请先输出你的思考过程，然后严格按照以下格式输出验证结果：\n\n思考：\n[你的思考过程]\n\n验证结果：\n[验证结论，成功或失败及原因]";

export class ValidateTool {
  private llm: LLM;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  async validate(state: ValidateState): Promise<ValidateResult> {
    var userMessage = "请验证以下执行结果：\n\n执行日志：" + state.execution_log;
    var messages = [
      { text: systemPrompt, role: "system" as const },
      { text: userMessage, role: "user" as const },
    ];
    var response = await this.llm.invoke(messages as any);
    return this.parseResponse(response.content);
  }

  async *streamValidate(state: ValidateState): AsyncGenerator<string, void, unknown> {
    var userMessage = "请验证以下执行结果：\n\n执行日志：" + state.execution_log;
    var messages = [
      { text: systemPrompt, role: "system" as const },
      { text: userMessage, role: "user" as const },
    ];
    var stream = this.llm.stream(messages as any);
    for await (var chunk of stream) {
      yield chunk.content;
    }
  }

  private parseResponse(content: string): ValidateResult {
    try {
      var thoughtMatch = content.match(/思考：([\s\S]*?)验证结果：/);
      var thought = thoughtMatch ? thoughtMatch[1].trim() : "";
      var resultMatch = content.match(/验证结果：([\s\S]*)/);
      var result = resultMatch ? resultMatch[1].trim() : "验证完成";
      return { result: result, thought: thought };
    } catch (e) {
      return { result: "验证失败", thought: "解析错误" };
    }
  }
}