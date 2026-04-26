/**
 * 计划工具 - 生成执行计划
 */

import { LLM } from "../core/llm";

export interface PlanState {
  analysis: {
    actions: Array<{
      action: string;
      target: string;
      details: string;
    }>;
  };
  related_memory: string;
}

export interface PlanResult {
  plan: {
    steps: Array<{
      action: string;
      params: any;
    }>;
  };
  thought: string;
}

var systemPrompt = `你是一个文档处理助手，负责根据需求分析生成可执行的Word操作步骤。

用户可能提出多个操作，你需要为每个操作生成对应的执行步骤。

请先输出你的思考过程，然后严格按照以下JSON格式输出执行计划：

思考：
[你的思考过程，列出将为每个操作生成的步骤]

执行计划：
{
  "steps": [
    {"action": "set_bold", "params": {"text": "要加粗的文本"}},
    {"action": "set_color", "params": {"text": "要设置颜色的文本", "color": "red"}},
    {"action": "replace_text", "params": {"oldText": "旧文本", "newText": "新文本"}},
    {"action": "save", "params": {}}
  ]
}`;

export class PlanTool {
  private llm: LLM;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  async plan(state: PlanState): Promise<PlanResult> {
    var actions = state.analysis?.actions || [];
    var userMessage = "根据需求分析，生成可执行的Word操作步骤。\n允许的动作：set_bold(加粗), set_color(设置颜色), replace_text(替换), save(保存)\n分析结果（包含所有操作）：" + JSON.stringify(actions) + "\n\n相关历史记录：" + state.related_memory;
    var messages = [
      { text: systemPrompt, role: "system" as const },
      { text: userMessage, role: "user" as const },
    ];
    var response = await this.llm.invoke(messages as any);
    return this.parseResponse(response.content);
  }

  async *streamPlan(state: PlanState): AsyncGenerator<string, void, unknown> {
    var actions = state.analysis?.actions || [];
    var userMessage = "根据需求分析，生成可执行的Word操作步骤。\n允许的动作：set_bold(加粗), set_color(设置颜色), replace_text(替换), save(保存)\n分析结果（包含所有操作）：" + JSON.stringify(actions) + "\n\n相关历史记录：" + state.related_memory;
    var messages = [
      { text: systemPrompt, role: "system" as const },
      { text: userMessage, role: "user" as const },
    ];
    var stream = this.llm.stream(messages as any);
    for await (var chunk of stream) {
      yield chunk.content;
    }
  }

  public parseResponse(content: string): PlanResult {
    try {
      var thoughtMatch = content.match(/思考：([\s\S]*?)执行计划：/);
      var thought = thoughtMatch ? thoughtMatch[1].trim() : "";
      var resultMatch = content.match(/执行计划：([\s\S]*)/);
      var resultStr = resultMatch ? resultMatch[1].trim() : "{\"steps\":[]}";
      var plan = JSON.parse(resultStr);
      return { plan: plan, thought: thought };
    } catch (e) {
      return {
        plan: { steps: [] },
        thought: "生成计划失败",
      };
    }
  }
}