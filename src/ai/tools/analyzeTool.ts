/**
 * ================================================================
 * AnalyzeTool — 需求分析工具（LangChain StructuredTool）
 * ================================================================
 *
 * 【职责】
 * 分析用户的 Word 文档操作需求，输出结构化的意图描述。
 * 只分析"用户想要什么"，不涉及具体操作方式和 SDK 调用。
 *
 * 【输出格式变化】
 *   旧版: { actions: [{ action: "replace_text", target: "公司", details: "..." }] }
 *         ↑ 过早规定了操作类型和参数，限制了后续阶段的灵活性
 *
 *   新版: {
 *     intent: "text_replace",
 *     operations: [{ type: "replace", target: "公司", goal: "替换为集团" }],
 *     context_hints: ["可能指全文所有'公司'"]
 *   }
 *         ↑ 只表达意图和语境，具体怎么做交给 Plan + Execute
 *
 * 【LLM 角色】
 *   这里的 LLM 扮演"需求分析师"——听懂用户的话，提炼出操作意图。
 *   它不需要理解 SDK 如何工作，只需要理解自然语言需求。
 * ================================================================
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

/** AnalyzeTool 的输入参数 schema */
const AnalyzeInputSchema = z.object({
  user_input: z.string().describe("用户的原始需求描述（自然语言）"),
  related_memory: z.string().describe("与该文档/需求相关的历史执行记录，用于参考之前的失败原因"),
  doc_context: z.string().describe("当前可用文档列表的描述，帮助 LLM 理解用户提到的文档名"),
});

/** AnalyzeTool 的输出类型（同时也是 _call 返回的 JSON 字符串对应的结构） */
export interface AnalyzeOutput {
  /** 用户需求的总体意图分类 */
  intent: "text_replace" | "format_change" | "mixed" | "other";
  /** 识别出的所有操作意图 */
  operations: Array<{
    type: "replace" | "format" | "insert" | "delete" | "save";
    target: string;     // 用户提到的目标描述，如"公司"、"标题"
    goal: string;       // 用户想要的效果，如"替换为集团"、"加粗"
    details: string;    // 补充说明，如"全文替换"、"只改第一处"
  }>;
  /** 上下文提示，帮助后续阶段理解用户意图 */
  context_hints: string[];
  /** 目标文档名（如果用户明确指定了文档） */
  target_doc?: string;
}

const SYSTEM_PROMPT = `你是一个文档处理需求的**分析专家**。
你的任务是根据用户的自然语言需求，提炼出结构化的操作意图。

【核心原则】
- 你只负责理解"用户想要什么"，不规定"具体怎么操作"
- 不要输出 SDK 调用指令、不要规定具体参数
- 如果用户的需求不明确，在 context_hints 中标注出来

【输出格式】
请严格按照以下 JSON 格式输出（不要加 \`\`\` 标记），只输出 JSON：

{
  "intent": "text_replace | format_change | mixed | other",
  "operations": [
    {
      "type": "replace | format | insert | delete | save",
      "target": "操作目标描述",
      "goal": "用户想要达成的效果",
      "details": "补充说明"
    }
  ],
  "context_hints": [
    "对当前需求的语境说明"
  ]
}

【类型说明】
- type = "replace": 替换文本（如"把A换成B"）
- type = "format":  修改格式（如"加粗"、"改颜色"）
- type = "insert":  插入内容（如"在A后面加B"）
- type = "delete":  删除内容（如"删掉A"）
- type = "save":    保存文档

【注意】
- intent 是对所有操作的综合分类
- operations 列表必须包含用户提到的每一个操作
- context_hints 要体现用户可能的言外之意（如"公司"可能指"有限公司"）`;

export class AnalyzeTool extends StructuredTool<typeof AnalyzeInputSchema> {
  name = "analyze_requirements";
  description = "分析用户的Word文档操作需求，输出结构化的操作意图描述";

  schema = AnalyzeInputSchema;

  private llm: ChatOpenAI;

  constructor(llm: ChatOpenAI) {
    super();
    this.llm = llm;
  }

  /**
   * 执行需求分析
   * @param input - 包含用户输入和历史记忆
   * @returns JSON 字符串，可解析为 AnalyzeOutput
   */
  async _call(input: z.infer<typeof AnalyzeInputSchema>): Promise<string> {
    const userMessage = [
      `## 用户需求`,
      input.user_input,
      ``,
      `## 当前可用文档`,
      input.doc_context,
      ``,
      `## 相关历史执行记录`,
      input.related_memory,
    ].join("\n");

    const response = await this.llm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userMessage),
    ]);

    const content = response.content.toString();
    return content;
  }
}
