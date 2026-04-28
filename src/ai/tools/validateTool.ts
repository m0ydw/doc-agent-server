/**
 * ================================================================
 * ValidateTool — 执行结果验证工具（LangChain StructuredTool）
 * ================================================================
 *
 * 【职责】
 * 验证 Execute 阶段的执行结果，判断是否成功、是否可重试、是否需要用户介入。
 *
 * 【判断逻辑】
 * - 成功: execution_log 中所有任务都标记为成功
 * - 可重试: 偶发错误（网络、超时、临时性问题）
 * - 不可重试: 文档不存在、权限问题、需要用户确认
 * - 需要用户介入: 模糊指令、歧义、需要用户提供更多信息
 *
 * 【LLM 角色】
 *   这里的 LLM 扮演"质检员"——检查执行日志，判断结果是否符合预期。
 *   它需要理解任务的 goal 和 success_criteria 来做出判断。
 * ================================================================
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

/** ValidateTool 的输入参数 schema */
const ValidateInputSchema = z.object({
  /** Execute 阶段输出的执行结果 JSON 字符串 */
  execution_log: z.string().describe("Execute 阶段的执行日志 JSON（包含 execution_log, task_status, success）"),
  /** 原始的计划任务清单 JSON（用于对照检查） */
  plan_tasks: z.string().describe("Plan 阶段的任务清单 JSON，用于对照检查任务是否完成"),
});

/** 验证结果输出 */
export interface ValidateOutput {
  /** 验证结论 */
  result: "成功" | "失败" | "部分成功";
  /** 详细说明 */
  summary: string;
  /** 是否可自动重试 */
  retryable: boolean;
  /** 是否需要用户介入 */
  needs_user_input: boolean;
  /** 失败的任务列表 */
  failed_tasks: string[];
  /** 失败原因分析（供记忆模块记录） */
  error_analysis: string;
}

const SYSTEM_PROMPT = `你是一个文档操作结果的**验证专家**。
你的任务是根据执行日志和任务清单，判断操作是否成功。

【判断标准】
1. 成功: 所有任务都按 success_criteria 完成了
2. 部分成功: 部分任务成功，部分失败（非关键任务失败可以接受）
3. 失败: 关键任务全部失败

【可重试判断】
- retryable = true: 临时性问题（网络波动、超时、偶发错误）
- retryable = false: 根本性问题（文档不存在、权限不足、不支持的操作）
- needs_user_input = true: 需要用户提供更多信息或确认

【输出格式】
{
  "result": "成功|失败|部分成功",
  "summary": "简要总结验证结果",
  "retryable": true/false,
  "needs_user_input": true/false,
  "failed_tasks": ["任务ID或描述"],
  "error_analysis": "失败原因分析"
}`;

export class ValidateTool extends StructuredTool<typeof ValidateInputSchema> {
  name = "validate_execution";
  description = "验证文档操作执行结果，判断成功/失败/是否需要重试或用户介入";

  schema = ValidateInputSchema;

  private llm: ChatOpenAI;

  constructor(llm: ChatOpenAI) {
    super();
    this.llm = llm;
  }

  async _call(input: z.infer<typeof ValidateInputSchema>): Promise<string> {
    const userMessage = [
      `## 执行日志`,
      input.execution_log,
      ``,
      `## 原始任务清单`,
      input.plan_tasks,
    ].join("\n");

    const response = await this.llm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userMessage),
    ]);

    return response.content.toString();
  }
}
