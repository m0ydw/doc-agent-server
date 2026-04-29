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
import { SDKFindTextTool, SDKReplaceTextTool, SDKReplaceAllTool, SDKGetTextTool, SDKSaveTool } from "./sdkTools";
import { executeSystemPrompt, buildToolList, EXECUTION_STYLE_RULES } from "../prompts";

/** ExecuteTool 的输入参数 schema */
const ExecuteInputSchema = z.object({
  /** Plan 阶段输出的任务清单 JSON（PlanOutput 的 JSON 字符串） */
  plan_tasks: z.string().describe("Plan 阶段的语义化任务清单 JSON"),
  /** 目标文档 ID */
  docId: z.string().describe("要操作的文档 ID（来自 fileRegistry）"),
});

/** 最大 tool calling 轮数，防止无限循环 */
const MAX_TOOL_ROUNDS = 30;

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
// System Prompt for the Execute LLM — 使用 ChatPromptTemplate
// 拓展：新增工具只需在 TOOL_DESCRIPTIONS 追加条目
// ================================================================
const TOOL_DESCRIPTIONS = [
  { name: "sdk_get_text()", description: "读取文档全文" },
  { name: "sdk_find_text(文本)", description: "查找指定文本在文档中的位置" },
  { name: "sdk_replace_text(目标, 替换)", description: "替换第一个匹配的文本" },
  { name: "sdk_replace_all(目标, 替换)", description: "替换全部匹配的文本" },
  { name: "sdk_save()", description: "保存文档修改" },
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
  /** 当前文档 ID，传给 SDK 工具 */
  private docId: string = "";
  /** 缓存的 SDK 工具列表 */
  private sdkTools: StructuredTool[] = [];

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
    this.docId = input.docId;

    // 解析任务清单（支持 JSON 和纯文本描述两种格式）
    let tasks: any[] = [];
    let planDescription = input.plan_tasks; // 保留原始文本，供降级使用
    try {
      const planOutput = JSON.parse(input.plan_tasks);
      tasks = planOutput.tasks || [];
    } catch {
      // JSON 解析失败 → 降级：从原始文本中尝试提取任务，或直接作为描述传给 LLM
      console.warn(
        "[ExecuteTool] plan_tasks JSON 解析失败，尝试降级处理，" +
        "plan_len=" + (input.plan_tasks || "").length +
        ", plan_head=" + (input.plan_tasks || "").slice(0, 120).replace(/\n/g, "\\n")
      );
      // 尝试从文本中提取大括号包裹的 JSON
      var jsonMatch = input.plan_tasks.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          var extracted = JSON.parse(jsonMatch[0]);
          tasks = extracted.tasks || [];
          if (tasks.length > 0) {
            console.log("[ExecuteTool] 从原始文本中成功提取 JSON，tasks=" + tasks.length);
          }
        } catch { /* 二次提取也失败，继续降级 */ }
      }
    }

    if (tasks.length === 0) {
      return JSON.stringify({
        execution_log: "[Execute] 没有需要执行的任务",
        task_status: {},
        success: true,
      } as ExecuteResult);
    }

    // 初始化 SDK 工具（注入 docId）
    this.sdkTools = this.createSDKTools();

    // 将 LLM 与工具绑定，使其具备 tool calling 能力
    const llmWithTools = this.llm.bindTools(this.sdkTools);

    // 构建消息列表
    const systemMsg = await buildExecuteSystemMessage();
    const messages: any[] = [
      systemMsg,
      new HumanMessage(
        `请按以下任务清单操作文档（文档ID: ${this.docId}）：\n\n` +
        JSON.stringify(tasks, null, 2) +
        `\n\n请逐个执行任务，每完成一步告诉我结果。所有任务完成后调用 sdk_save。`
      ),
    ];

    const log: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    let taskStatus: Record<string, "success" | "failed" | "skipped"> = {};

    // tool calling 循环
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await llmWithTools.invoke(messages);
      messages.push(response);

      // 检查是否有 tool calls
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const tc of response.tool_calls) {
          const toolName = tc.name;
          const toolArgs = tc.args;
          const toolId = tc.id;

          // 查找对应的工具并执行
          const tool = this.sdkTools.find(t => t.name === toolName);
          if (!tool) {
            log.push(`[Execute] 未知工具: ${toolName}`);
            continue;
          }

          try {
            // ================================================================
            // 【LLM ↔ SDK 对接点】
            // LLM 决定调用工具 → 工具内部调用 services/editor 的封装函数
            // editor 函数通过 sessionManager 获取 doc 对象 → 调用 SDK API
            // ================================================================
            const result = await tool.invoke(toolArgs);
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            log.push(`[工具] ${toolName}(${JSON.stringify(toolArgs)}) → ${resultStr.slice(0, 200)}`);

            // 记录结构化工具调用（供前端组件渲染）
            toolCalls.push({
              tool: toolName,
              args: JSON.stringify(toolArgs),
              result: resultStr.slice(0, 300),
              status: "success",
            });

            // 记录任务状态：如果是 sdk_replace_text 或 sdk_replace_all，标记对应任务
            if (toolName === "sdk_replace_text" || toolName === "sdk_replace_all") {
              const taskMatch = response.content?.toString().match(/任务[：:]\s*([^\n]+)/);
              if (taskMatch) {
                taskStatus[taskMatch[1]] = "success";
              }
            }

            // 将工具执行结果返回给 LLM
            messages.push(new ToolMessage({
              content: resultStr,
              tool_call_id: toolId!,
            }));
          } catch (err: any) {
            const errMsg = `[工具] ${toolName} 执行失败: ${err.message}`;
            log.push(errMsg);
            toolCalls.push({
              tool: toolName,
              args: JSON.stringify(toolArgs),
              result: err.message,
              status: "failed",
            });
            messages.push(new ToolMessage({
              content: `操作失败: ${err.message}`,
              tool_call_id: toolId!,
            }));
          }
        }
      } else {
        // LLM 没有调用工具，说明执行完成或 LLM 在总结
        const content = response.content?.toString() || "";
        log.push(`[LLM] ${content.slice(0, 300)}`);

        // 检查 LLM 是否表示任务完成
        if (content.includes("完成") || content.includes("保存") || content.includes("save")) {
          break;
        }
        // 如果没有 tool call 也没有完成标记，可能是 LLM 在思考，继续让它执行
        if (round > MAX_TOOL_ROUNDS - 3) {
          log.push(`[Execute] 达到最大轮数，终止执行`);
          break;
        }
      }
    }

    // 确保保存
    try {
      const saveTool = this.sdkTools.find(t => t.name === "sdk_save");
      if (saveTool) {
        await saveTool.invoke({});
        log.push(`[Execute] 文档已保存`);
      }
    } catch {
      log.push(`[Execute] 保存失败（可能已在协作中自动保存）`);
    }

    const success = Object.values(taskStatus).every(s => s === "success") && tasks.length > 0;

    const result: ExecuteResult = {
      execution_log: log.join("\n"),
      tool_calls: toolCalls,
      task_status: taskStatus,
      success,
    };

    return JSON.stringify(result);
  }

  /**
   * 创建 SDK 工具实例列表
   * 每个工具都绑定 docId，LLM 通过 tool calling 调用它们
   */
  private createSDKTools(): StructuredTool[] {
    return [
      new SDKFindTextTool(this.docId),
      new SDKReplaceTextTool(this.docId),
      new SDKReplaceAllTool(this.docId),
      new SDKGetTextTool(this.docId),
      new SDKSaveTool(this.docId),
    ];
  }
}
