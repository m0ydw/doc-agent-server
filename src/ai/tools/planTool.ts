/**
 * ================================================================
 * PlanTool — 任务规划工具（LangChain StructuredTool）
 * ================================================================
 *
 * 【职责】
 * 根据 Analyze 阶段输出的意图分析，制定语义化的任务清单。
 * 它是"制定者"——决定"要做什么"，但不规定"具体怎么做"。
 *
 * 【与旧版的根本区别】
 *   旧版输出机械指令 JSON：
 *     { "steps": [{"action": "replace_text", "params": {"oldText":..., "newText":...}}] }
 *     ↑ Execute 只能机械执行，没有任何智能空间
 *
 *   新版输出语义化任务描述：
 *     { "tasks": [{"goal": "将'公司'替换为'集团'", "description": "...", "constraints": [...]}] }
 *     ↑ Execute 的 LLM 自主决定如何实现
 *
 * 【数据流】
 *   Analyze → Plan → Execute
 *   "要做什么"    "拆分为任务"    "LLM驱动实现"
 *   (意图)        (任务清单)     (SDK调用)
 *
 * 【LLM 角色】
 *   这里的 LLM 扮演"项目经理"——把需求分析拆解为可执行的任务单元，
 *   预见可能的失败场景，提供备选方案。
 *   它不需要知道 SDK 细节，只需要理解文档操作的语义。
 * ================================================================
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

/** PlanTool 的输入参数 schema */
const PlanInputSchema = z.object({
  /** Analyze 阶段输出的 JSON 字符串（AnalyzeOutput） */
  analysis: z.string().describe("需求分析结果 JSON，包含 intent/operations/context_hints"),
  /** 相关历史记忆 */
  related_memory: z.string().describe("历史执行记录，帮助规划时避免重复失败"),
  /** 文档上下文 */
  doc_context: z.string().describe("当前可用文档信息"),
});

/** 任务项 — PlanTool 输出中的单个任务 */
export interface PlanTask {
  id: string;                    // 唯一标识，如 "task-1"
  goal: string;                  // 一句话目标，如 "替换公司名"
  description: string;           // 详细描述，说明要达成的效果
  constraints: string[];         // 约束条件，Execute 必须遵守
  success_criteria: string;      // 如何判断成功
  priority: "high" | "medium" | "low";
}

/** PlanTool 的输出类型 */
export interface PlanOutput {
  tasks: PlanTask[];
  dependencies: Array<{ from: string; to: string; reason: string }>;
  ordering: "sequential" | "parallel";
  fallback_strategies: Array<{
    condition: string;    // 什么情况下触发
    action: string;       // 备选方案描述
  }>;
}

const SYSTEM_PROMPT = `你是一个文档处理任务的**规划专家**。
你的职责是根据需求分析结果，制定一个语义化的任务清单。

【核心原则】
- 你只负责规划"要做什么"（what），不规定"怎么做"（how）
- 每个任务应该是一个清晰的高层目标，让执行者能理解意图
- 不要输出具体的 SDK 调用指令或 API 参数
- 要预见到可能的失败场景，提供备选方案

【任务设计原则】
1. 每个任务必须有一个明确的 goal（一句话说清要什么）
2. description 要用自然语言描述，让执行 LLM 能理解
3. constraints 是关键！执行 LLM 会严格遵守这些约束
4. success_criteria 要可验证，帮助执行完后自检
5. 如果任务之间有依赖关系，在 dependencies 中说明

【输出格式】
请严格按照以下 JSON 格式输出（不要加 \`\`\` 标记），只输出 JSON：

{
  "tasks": [
    {
      "id": "task-1",
      "goal": "任务的一句话目标",
      "description": "详细描述要完成的任务，包括具体的文本内容、位置等",
      "constraints": ["约束条件1", "约束条件2"],
      "success_criteria": "如何判断任务成功",
      "priority": "high"
    }
  ],
  "dependencies": [
    { "from": "task-1", "to": "task-2", "reason": "为什么task-2依赖task-1" }
  ],
  "ordering": "sequential",
  "fallback_strategies": [
    { "condition": "什么情况下触发", "action": "备选方案描述" }
  ]
}

【示例】
输入:
  intent: "text_replace",
  operations: [{ type: "replace", target: "公司", goal: "替换为集团" }],
  context_hints: ["可能指全文所有出现"]

输出:
{
  "tasks": [
    {
      "id": "task-1",
      "goal": "替换公司名为集团",
      "description": "将文档中所有出现的'公司'文字替换为'集团'，注意不要遗漏、不要改错字",
      "constraints": ["全文档范围内替换", "只替换独立词组'公司'，不替换'公司'作为其他词的一部分"],
      "success_criteria": "文档中不再有独立'公司'一词，所有替换位置内容正确",
      "priority": "high"
    }
  ],
  "dependencies": [],
  "ordering": "sequential",
  "fallback_strategies": [
    { "condition": "找不到精确匹配的'公司'", "action": "尝试查找'有限公 司'、'本公司'等常见变体" },
    { "condition": "替换后发现语义不通顺", "action": "回退替换并报告异常" }
  ]
}`;

export class PlanTool extends StructuredTool<typeof PlanInputSchema> {
  name = "plan_tasks";
  description = "根据需求分析结果，制定语义化的文档操作任务清单";

  schema = PlanInputSchema;

  private llm: ChatOpenAI;

  constructor(llm: ChatOpenAI) {
    super();
    this.llm = llm;
  }

  /**
   * 生成执行计划
   * @param input - 包含分析结果和历史记忆
   * @returns JSON 字符串，可解析为 PlanOutput
   */
  async _call(input: z.infer<typeof PlanInputSchema>): Promise<string> {
    // 尝试解析 analysis JSON 以提取关键信息供 LLM 参考
    let analysisSummary = input.analysis;
    try {
      const parsed = JSON.parse(input.analysis);
      const ops = parsed.operations || [];
      const hints = parsed.context_hints || [];
      analysisSummary = [
        `操作意图: ${parsed.intent || "未明确"}`,
        `操作列表:`,
        ...ops.map((o: any, i: number) => `  ${i + 1}. 类型=${o.type}, 目标="${o.target}", 目的="${o.goal}"`),
        hints.length > 0 ? `语境提示: ${hints.join("; ")}` : "",
      ].join("\n");
    } catch {
      // 如果解析失败，直接使用原始字符串
    }

    const userMessage = [
      `## 需求分析结果`,
      analysisSummary,
      ``,
      `## 当前可用文档`,
      input.doc_context,
      ``,
      `## 相关历史记录`,
      input.related_memory,
    ].join("\n");

    const response = await this.llm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userMessage),
    ]);

    return response.content.toString();
  }
}
