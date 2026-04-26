/**
 * 分析工具 - 需求分析
 */

import { LLM, LLMResponse } from "../core/llm";

export interface AnalyzeState {
  user_input: string;
  related_memory: string;
}

export interface AnalyzeResult {
  analysis: {
    actions: Array<{
      action: string;
      target: string;
      details: string;
    }>;
  };
  thought: string;
}

var systemPrompt = `你是一个文档处理助手，负责分析用户的Word操作需求。用户可能提出多个操作，请全部识别出来。

请先输出你的思考过程，然后严格按照以下JSON格式输出分析结果（支持多个操作）：

思考：
[你的思考过程，列出所有识别的操作]

分析结果：
{
  "actions": [
    {"action": "操作类型", "target": "操作目标", "details": "详细信息"},
    ...
  ]
}

允许的操作类型：
- set_bold: 加粗文本，需要参数 text
- set_color: 设置颜色，需要参数 text, color  
- replace_text: 替换文本，需要参数 oldText, newText
- save: 保存文档`;

export class AnalyzeTool {
  private llm: LLM;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  async analyze(state: AnalyzeState): Promise<AnalyzeResult> {
    var userMessage = "请分析用户的Word操作需求：" + state.user_input + "\n\n相关历史记录：" + state.related_memory;
    var messages = [
      { text: systemPrompt, role: "system" as const },
      { text: userMessage, role: "user" as const },
    ];
    var response = await this.llm.invoke(messages as any);
    return this.parseResponse(response.content);
  }

  async *streamAnalyze(state: AnalyzeState): AsyncGenerator<string, void, unknown> {
    var userMessage = "请分析用户的Word操作需求：" + state.user_input + "\n\n相关历史记录：" + state.related_memory;
    var messages = [
      { text: systemPrompt, role: "system" as const },
      { text: userMessage, role: "user" as const },
    ];
    var stream = this.llm.stream(messages as any);
    for await (var chunk of stream) {
      yield chunk.content;
    }
  }

  public parseResponse(content: string): AnalyzeResult {
    try {
      var thoughtMatch = content.match(/思考：([\s\S]*?)分析结果：/);
      var thought = thoughtMatch ? thoughtMatch[1].trim() : "";
      var resultMatch = content.match(/分析结果：([\s\S]*)/);
      var resultStr = resultMatch ? resultMatch[1].trim() : "{}";
      var analysis = JSON.parse(resultStr);
      
      // 确保 actions 字段存在
      if (!analysis.actions) {
        analysis.actions = [];
      }
      
      return { analysis: analysis, thought: thought };
    } catch (e) {
      return {
        analysis: { actions: [] },
        thought: "分析失败",
      };
    }
  }
}