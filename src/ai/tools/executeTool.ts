/**
 * ================================================================
 * ExecuteTool — LLM 驱动的智能文档操作执行器
 * ================================================================
 *
 * 【改造说明】
 *   旧版: 机械的 switch-case 翻译器
 *     for (step of plan.steps) {
 *       if (action === "replace_text") editor.replaceFirst(...)
 *       if (action === "set_bold")    假装加粗...
 *     }
 *     没有 LLM 介入，没有智能判断，遇到异常直接失败
 *
 *   新版: LLM 驱动的智能执行器
 *     输入: Plan 的语义化任务清单（tasks[].goal / description / constraints）
 *     工具: 5 个 SDK 操作工具（包装自 services/editor）
 *     行为: LLM 自主理解任务 → 调用工具实现 → 验证结果 → 处理异常
 *
 * 【LLM ↔ SDK 调用链】
 *   ┌──────────────────────────────────────────────────────┐
 *   │ LLM 决策层            SDK 工具层 (sdkTools.ts)       │
 *   │ ──────────            ────────────────────           │
 *   │ "查找'公司'文本"  →   sdk_find_text                  │
 *   │                        └→ editor.findText()          │
 *   │                            └→ doc.query.match()     │
 *   │                                                     │
 *   │ "替换第2处匹配"   →   sdk_replace_text              │
 *   │                        └→ editor.replaceFirst()     │
 *   │                            └→ doc.mutations.apply() │
 *   │                                                     │
 *   │ "读取全文验证"    →   sdk_get_text                  │
 *   │                        └→ editor.getText()          │
 *   │                            └→ doc.getText()         │
 *   │                                                     │
 *   │ "全部替换"        →   sdk_replace_all               │
 *   │                        └→ editor.replaceAll()       │
 *   │                            └→ doc.mutations.apply() │
 *   └──────────────────────────────────────────────────────┘
 *
 * 【异常处理流程】
 *   当 SDK 调用失败时（如找不到文本），LLM 会：
 *   1. 读取错误信息
 *   2. 参照 Plan 提供的 fallback_strategies
 *   3. 尝试替代方案（模糊匹配、变体查找）
 *   4. 记录失败原因到 execution_log
 *
 * 【设计原则】
 *   - 所有 SDK 调用都经过 services/editor 封装（已有的 SDK Agent）
 *   - 不直接操作 doc.query.match() / doc.mutations.apply()
 *   - LLM 通过 tool calling 调用工具，不需要手写 Agent 循环
 * ================================================================
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { SDKFindTextTool, SDKReplaceTextTool, SDKReplaceAllTool, SDKGetTextTool, SDKTaskCompleteTool, SDKSetTextTool, SDKApplyFormatTool, SDKGetStructureTool, SDKFindCellTool, SDKReadTableTool } from "./sdkTools";
import { executeSystemPrompt, buildToolList, EXECUTION_STYLE_RULES } from "../prompts";
import { extractAndParseJson } from "../core/jsonExtractor";
import { logLlmInvokeStart, logLlmInvokeResult } from "../core/debugLogger";

/** ExecuteTool 的输入参数 schema */
const ExecuteInputSchema = z.object({
  /** Plan 阶段输出的任务清单 JSON（PlanOutput 的 JSON 字符串） */
  plan_tasks: z.string().describe("Plan 阶段的语义化任务清单 JSON"),
  /** 目标文档 ID */
  docId: z.string().describe("要操作的文档 ID（来自 fileRegistry）"),
});

/** 最大 tool calling 轮数，防止无限循环 */
const MAX_TOOL_ROUNDS = 30;

/** 日志中错误消息最大长度 */
const ERROR_MSG_MAX_LEN = 150;

/** 日志中原始结果预览最大长度 */
const RAW_RESULT_HEAD_LEN = 120;

/** 单次工具调用记录 */
export interface ToolCallRecord {
  /** 工具名，如 sdk_get_text */
  tool: string;
  /** 调用参数（JSON 字符串） */
  args: string;
  /** 工具执行结果摘要 */
  result: string;
  /** 执行状态 */
  status: "success" | "failed";
}

/** 最终执行结果 */
export interface ExecuteResult {
  /** 执行日志，记录每一步的操作和结果（保留向后兼容） */
  execution_log: string;
  /** 结构化的工具调用记录列表（供前端组件渲染） */
  tool_calls: ToolCallRecord[];
  /** 每个任务的执行状态 */
  task_status: Record<string, "success" | "failed" | "skipped">;
  /** 是否完全成功 */
  success: boolean;
}

// ================================================================
// 流式执行事件类型（异步生成器模式，替代批量返回）
// ================================================================

/** 执行流中的单个事件 */
export interface ExecuteToolEvent {
  type: "tool_start" | "tool_result" | "done";
  tool?: string;
  args?: string;
  result?: string;
  status?: "success" | "failed";
  executionLog?: string;
  success?: boolean;
}

// ================================================================
// System Prompt for the Execute LLM — 使用 ChatPromptTemplate
// 拓展：新增工具只需在 TOOL_DESCRIPTIONS 追加条目
// ================================================================
const TOOL_DESCRIPTIONS = [
  { name: "sdk_get_text()", description: "读取文档全文" },
  { name: "sdk_get_structure()", description: "提取文档结构（表格/段落/单元格位置），填表前必调" },
  { name: "sdk_find_cell(文本)", description: "在表格中查找含指定文本的单元格（如'姓名'），返回 ref 供写入" },
  { name: "sdk_find_text(文本)", description: "查找指定文本在文档中的位置" },
  { name: "sdk_replace_text(目标, 替换)", description: "替换第一个匹配的文本" },
  { name: "sdk_replace_all(目标, 替换)", description: "替换全部匹配的文本" },
  { name: "sdk_read_table(索引)", description: "★★★ 读取表格结构地图，返回 JSON（行列坐标+写入ref）。ref 可直接传给 sdk_set_text 写入。填表第一步必调，只需调一次" },
  { name: "sdk_set_text(ref, 内容)", description: "★★★ 在指定位置写入文本。ref 来自 sdk_read_table 返回的 cells[].ref。如果任务描述中已有具体数据值，直接调用此工具写入，不要再去其他文档查找" },
  { name: "sdk_apply_format(文本, 粗体?, 斜体?)", description: "对指定文本应用格式（加粗/斜体/下划线）" },
];

async function buildExecuteSystemMessage(): Promise<SystemMessage> {
  const toolList = buildToolList(TOOL_DESCRIPTIONS);
  const messages = await executeSystemPrompt.formatMessages({
    tool_list: toolList,
    execution_style_rules: EXECUTION_STYLE_RULES,
  });
  return messages[0] as SystemMessage;
}

export class ExecuteTool extends StructuredTool<typeof ExecuteInputSchema> {
  name = "execute_tasks";
  description = "根据任务清单执行文档操作，支持智能处理和异常恢复";

  schema = ExecuteInputSchema;

  private llm: ChatOpenAI;

  constructor(llm: ChatOpenAI) {
    super();
    this.llm = llm;
  }

  /**
   * 执行所有任务
   *
   * 【执行流程】
   *   1. 解析 plan_tasks JSON，得到任务清单
   *   2. 创建带 SDK 工具的 LLM（bindTools）
   *   3. 进入 tool calling 循环：
   *      a. LLM 决定调用哪个工具
   *      b. 执行工具，记录日志
   *      c. 将结果送回 LLM
   *      d. LLM 决定下一步
   *   4. 所有任务完成后汇总日志
   *
   * 【为什么不用 AgentExecutor？】
   *   为了保持对执行过程的精细控制（日志格式、终止条件、错误处理），
   *   这里手动实现了 tool calling 循环，而不是使用 AgentExecutor。
   *   效果等价，但日志记录更精确。
   */
  async _call(input: z.infer<typeof ExecuteInputSchema>): Promise<string> {
    const docId = input.docId;
    let planTasks: any[] = [];
    try {
      const planOutput = JSON.parse(input.plan_tasks);
      planTasks = planOutput.tasks || [];
    } catch {
      console.warn(
        "[ExecuteTool] plan_tasks JSON 解析失败，尝试降级处理，" +
        "plan_len=" + (input.plan_tasks || "").length +
        ", plan_head=" + (input.plan_tasks || "").slice(0, 120).replace(/\n/g, "\\n")
      );
      const extracted = extractAndParseJson(input.plan_tasks);
      if (extracted) {
        planTasks = (extracted as any).tasks || [];
        if (planTasks.length > 0) {
          console.log("[ExecuteTool] 从原始文本中成功提取 JSON，tasks=" + planTasks.length);
        }
      }
    }

    // 委托给流式执行器，收集所有事件
    const log: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    let taskStatus: Record<string, "success" | "failed" | "skipped"> = {};
    let success = false;

    for await (const event of executeTasksStream(this.llm, docId, planTasks)) {
      if (event.type === "tool_start" || event.type === "tool_result") {
        // 收集工具调用记录（保持 _call 返回 JSON 的兼容性）
        if (event.type === "tool_result" && event.tool !== "task_complete") {
          toolCalls.push({
            tool: event.tool!,
            args: "", // 从 tool_start 已获取，简化处理
            result: event.result || "",
            status: event.status || "success",
          });
        }
      } else if (event.type === "done") {
        if (event.executionLog) log.push(event.executionLog);
        success = event.success ?? false;
      }
    }

    const result: ExecuteResult = {
      execution_log: log.join("\n"),
      tool_calls: toolCalls,
      task_status: taskStatus,
      success,
    };

    return JSON.stringify(result);
  }
}

// ================================================================
// executeTasksStream — 流式工具执行（异步生成器模式）
// ================================================================

/**
 * 流式执行文档操作任务，逐个 yield 工具调用事件
 *
 * 【为什么不用 ExecuteTool.invoke() 等 Promise 返回？】
 *   invoke() 是一个同步屏障 — 它在内部完成所有工具调用后才返回 JSON。
 *   前端在此期间收不到任何事件，最终看到的是"批量化一次性渲染"。
 *
 *   本函数将 tool calling 循环改为 AsyncGenerator，在每个工具
 *   执行前 yield tool_start，执行后 yield tool_result，
 *   使得前端可以实时渲染工具标签（loading → done/error）。
 *
 * @param llm       LLM 实例
 * @param docId     目标文档 ID
 * @param planTasks Plan 阶段的任务数组
 * @yields ExecuteToolEvent — 逐工具流式事件
 */
export async function* executeTasksStream(
  llm: ChatOpenAI,
  docId: string,
  planTasks: any[]
): AsyncGenerator<ExecuteToolEvent, void, unknown> {
  if (planTasks.length === 0) {
    yield { type: "done", executionLog: "[Execute] 没有需要执行的任务", success: true };
    return;
  }

  // 初始化 SDK 工具
  const sdkTools: StructuredTool[] = [
    new SDKFindTextTool(docId),
    new SDKReplaceTextTool(docId),
    new SDKReplaceAllTool(docId),
    new SDKGetTextTool(docId),
    new SDKSetTextTool(docId),
    new SDKApplyFormatTool(docId),
    new SDKGetStructureTool(docId),
    new SDKFindCellTool(docId),
    new SDKReadTableTool(docId),
    new SDKTaskCompleteTool(),
  ];

  const llmWithTools = llm.bindTools(sdkTools);

  const systemMsg = await buildExecuteSystemMessage();
  const messages: any[] = [
    systemMsg,
    new HumanMessage(
      `请按以下任务清单操作文档（文档ID: ${docId}）：\n\n` +
      JSON.stringify(planTasks, null, 2) +
      `\n\n请逐个执行任务，每完成一步告诉我结果。所有任务完成后调用 task_complete。`
    ),
  ];

  const log: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let taskStatus: Record<string, "success" | "failed" | "skipped"> = {};

  // ===== L3 防护状态 =====
  const toolCallMap = new Map<string, number>(); // toolName|args → count
  let lastReadRound = -1;  // 最后一次 readTable 的轮次
  let writeCount = 0;      // sdk_set_text 调用次数
  let guardInjected = { maxCalls: false, repeat: false, writeAfterRead: false };

  // tool calling 循环
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // ===== L3 防护：注入系统消息（LLM 可见） =====
    // 1. maxToolCalls — 超过 25 步时提示 LLM 尽快结束
    if (round >= 25 && !guardInjected.maxCalls) {
      messages.push(new SystemMessage("你已执行 25 步工具调用，请立即调用 task_complete 结束本轮执行。"));
      guardInjected.maxCalls = true;
    }

    // 2. writeAfterRead — readTable 后 10 步内无写入
    if (lastReadRound >= 0 && (round - lastReadRound) > 10 && writeCount === 0 && !guardInjected.writeAfterRead) {
      messages.push(new SystemMessage(
        "你已调用 sdk_read_table 获取了表格结构，但尚未调用 sdk_set_text 写入任何数据。" +
        "请立即使用 cells[].ref 调用 sdk_set_text 填入用户提供的数据。"
      ));
      guardInjected.writeAfterRead = true;
    }

    const endInvokeLog = logLlmInvokeStart(`ExecuteTool.round${round + 1}`);
    const response = await llmWithTools.invoke(messages);
    logLlmInvokeResult(`ExecuteTool.round${round + 1}`, response.content?.toString() || null, response.tool_calls);
    endInvokeLog?.();
    messages.push(response);

    if (response.tool_calls && response.tool_calls.length > 0) {
      let shouldBreak = false;
      for (const tc of response.tool_calls) {
        const toolName = tc.name;

        // task_complete: LLM 显式声明完成 → 立即终止
        if (toolName === "task_complete") {
          log.push("[Execute] LLM 调用 task_complete，执行结束");
          shouldBreak = true;
          break;
        }

        const toolArgs = tc.args;
        const toolId = tc.id;

        const tool = sdkTools.find(t => t.name === toolName);
        if (!tool) {
          log.push(`[Execute] 未知工具: ${toolName}`);
          // 必须回 ToolMessage，否则下一次 LLM 调用会因 tool_call_id 缺失而报错
          messages.push(new ToolMessage({
            content: `未知工具: ${toolName}（该工具不可用）`,
            tool_call_id: toolId!,
          }));
          continue;
        }

        // ★ yield tool_start 事件（前端立即渲染 loading 标签）
        yield {
          type: "tool_start",
          tool: toolName,
          args: JSON.stringify(toolArgs),
        };

        try {
          const result = await tool.invoke(toolArgs);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          log.push(`[工具] ${toolName}(${JSON.stringify(toolArgs)}) → ${resultStr.slice(0, 200)}`);

          if (toolName !== "task_complete") {
            toolCalls.push({
              tool: toolName,
              args: JSON.stringify(toolArgs),
              result: resultStr.slice(0, 300),
              status: "success",
            });
          }

          // ★ yield tool_result 事件（前端更新标签为 done/error）
          yield {
            type: "tool_result",
            tool: toolName,
            result: resultStr,
            status: "success",
          };

          if (toolName === "sdk_replace_text" || toolName === "sdk_replace_all") {
            const taskMatch = response.content?.toString().match(/任务[：:]\s*([^\n]+)/);
            if (taskMatch) {
              taskStatus[taskMatch[1]] = "success";
            }
          }

          messages.push(new ToolMessage({
            content: resultStr,
            tool_call_id: toolId!,
          }));

          // ===== L3 防护：记录工具调用 =====
          // 1. 同工具+同参数计数
          const argsSig = JSON.stringify(toolArgs || {});
          const callKey = `${toolName}|${argsSig}`;
          toolCallMap.set(callKey, (toolCallMap.get(callKey) || 0) + 1);

          // 2. readTable 轮次记录
          if (toolName === "sdk_read_table") {
            lastReadRound = round;
            guardInjected.writeAfterRead = false; // 新一轮 readTable 重置防护
          }

          // 3. sdk_set_text 计数
          if (toolName === "sdk_set_text") {
            writeCount++;
            guardInjected.writeAfterRead = false; // 有写入，重置防护
          }

          // 4. 同工具重复防护（3 次以上注入提示）
          const callCount = toolCallMap.get(callKey) || 0;
          if (callCount >= 3 && !guardInjected.repeat) {
            messages.push(new SystemMessage(
              `${toolName} 已重复调用 ${callCount} 次且结果相同，请换用其他工具或调用 task_complete 结束。`
            ));
            guardInjected.repeat = true;
          }
        } catch (err: any) {
          const errMsg = `[工具] ${toolName} 执行失败: ${err.message}`;
          log.push(errMsg);
          toolCalls.push({
            tool: toolName,
            args: JSON.stringify(toolArgs),
            result: err.message,
            status: "failed",
          });

          yield {
            type: "tool_result",
            tool: toolName,
            result: err.message,
            status: "failed",
          };

          messages.push(new ToolMessage({
            content: `操作失败: ${err.message}`,
            tool_call_id: toolId!,
          }));
        }
      }
      if (shouldBreak) break;
    } else {
      // LLM 没有调用工具 → 可能是思考中，继续
      const content = response.content?.toString() || "";
      log.push(`[LLM] (无工具调用) ${content.slice(0, 300)}`);
      // 接近最大轮数时终止（安全兜底）
      if (round > MAX_TOOL_ROUNDS - 3) {
        log.push(`[Execute] 达到最大轮数，强制终止`);
        break;
      }
    }
  }

  // Yjs 协作模式自动同步，无需显式保存
  const success = Object.values(taskStatus).every(s => s === "success") && planTasks.length > 0;

  // ★ yield done 事件（携带执行日志和成功状态）
  yield {
    type: "done",
    executionLog: log.join("\n"),
    success,
  };
}

// ================================================================
// 解析辅助函数（改进项 3）
// 从 ExecuteTool 的原始输出中提取结构化数据，供 globalAgent.ts 使用
// ================================================================

/**
 * 解析 ExecuteTool 返回的 JSON 字符串
 *
 * @param rawResult - ExecuteTool.invoke() 返回的原始字符串
 * @returns 解析后的结构（解析失败时返回空工具调用列表和原始日志）
 */
export function parseExecuteResult(
  rawResult: string
): { executionLog: string; toolCalls: ToolCallRecord[]; success: boolean | null } {
  try {
    const parsed = JSON.parse(rawResult);
    const executionLog = parsed.execution_log || rawResult;
    const toolCalls: ToolCallRecord[] = parsed.tool_calls || [];
    const success: boolean | null = typeof parsed.success === "boolean" ? parsed.success : null;
    return { executionLog, toolCalls, success };
  } catch (e: any) {
    console.warn(
      "[ExecuteTool] JSON 解析失败，使用原始日志作为 execution_log，" +
      "err=" + e.message?.slice(0, ERROR_MSG_MAX_LEN) +
      ", raw_len=" + rawResult.length +
      ", raw_head=" + rawResult.slice(0, RAW_RESULT_HEAD_LEN).replace(/\n/g, "\\n")
    );
    return { executionLog: rawResult, toolCalls: [], success: null };
  }
}

/**
 * 从 ExecuteTool 返回的 JSON 中提取文档片段（sdk_get_text 的结果）
 *
 * @param rawResult - ExecuteTool 返回的原始字符串
 * @param maxLength - 最大返回长度（默认 4000）
 * @returns 提取到的文档文本片段
 */
export function extractDocSnippet(rawResult: string, maxLength: number = 4000): string {
  try {
    const parsed = JSON.parse(rawResult);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      for (const tc of parsed.tool_calls) {
        if (tc.tool === "sdk_get_text" && tc.result) {
          const textMatch = tc.result.match(/：(.+)/);
          const snippet = textMatch ? textMatch[1] : tc.result;
          return snippet.length > maxLength
            ? snippet.substring(0, maxLength) + "...(已截断)"
            : snippet;
        }
      }
    }
  } catch {
    // 提取失败，返回空字符串
  }
  return "";
}
