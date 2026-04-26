/**
 * 验证工具 - 验证执行结果
 * 包含错误分类：可重试 vs 需要用户介入
 */

import { LLM } from "../core/llm";

export interface ValidateState {
  execution_log: string;
}

export interface ValidateResult {
  result: string;
  thought: string;
  retryable: boolean;
  needsUserInput: boolean;
}

var systemPrompt = `你是一个文档处理助手，负责验证执行结果是否正确。

请检查执行日志，判断每个操作是否成功，并识别错误类型。

请先输出你的思考过程，然后严格按照以下格式输出验证结果：

思考：
[你的思考过程，逐个检查执行日志中的操作]

验证结果：
{
  "result": "验证结论，成功或失败及简要原因",
  "retryable": true/false,
  "needsUserInput": true/false,
  "failedSteps": ["步骤1", "步骤2"] // 失败的步骤列表
}

关键判断规则：
- retryable: false（不可重试）当出现：文档不存在、文件无法打开、权限问题、无法解析的内容、需要用户提供更多信息
- retryable: true（可重试）当出现：临时网络问题、偶发错误、重试可能成功的情况
- needsUserInput: true 当：需要用户提供更多信息、无法自动判断、操作对象不明确`;

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

  public parseResponse(content: string): ValidateResult {
    try {
      var thoughtMatch = content.match(/思考：([\s\S]*?)验证结果：/);
      var thought = thoughtMatch ? thoughtMatch[1].trim() : "";
      
      // 尝试解析 JSON
      var resultMatch = content.match(/验证结果：([\s\S]*)/);
      var resultStr = resultMatch ? resultMatch[1].trim() : "{}";
      
      // 提取 JSON（可能包含一些额外文本）
      var jsonMatch = resultStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        var parsed = JSON.parse(jsonMatch[0]);
        return {
          result: parsed.result || "验证完成",
          thought: thought,
          retryable: parsed.retryable !== false, // 默认 true
          needsUserInput: parsed.needsUserInput === true,
        };
      }
      
      // JSON 解析失败，智能判断
      var isSuccess = resultStr.indexOf("成功") >= 0 && resultStr.indexOf("失败") < 0;
      var isRetryable = resultStr.indexOf("不可重试") < 0 && resultStr.indexOf("需要用户") < 0;
      var needsUser = resultStr.indexOf("需要用户") >= 0 || resultStr.indexOf("无法确定") >= 0;
      
      return {
        result: resultStr,
        thought: thought,
        retryable: isRetryable,
        needsUserInput: needsUser,
      };
    } catch (e) {
      // 简单的错误识别
      var isRetryable = content.indexOf("失败") >= 0 && content.indexOf("文档不存在") < 0;
      return { 
        result: "验证完成（解析失败）", 
        thought: "解析错误: " + (e as Error).message,
        retryable: isRetryable,
        needsUserInput: content.indexOf("需要") >= 0,
      };
    }
  }
}