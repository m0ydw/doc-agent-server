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

/** ExecuteTool 的输入参数 schema */
const ExecuteInputSchema = z.object({
  /** Plan 阶段输出的任务清单 JSON（PlanOutput 的 JSON 字符串） */
  plan_tasks: z.string().describe("Plan 阶段的语义化任务清单 JSON"),
  /** 目标文档 ID */
  docId: z.string().describe("要操作的文档 ID（来自 fileRegistry）"),
});

/** 最大 tool calling 轮数，防止无限循环 */
const MAX_TOOL_ROUNDS = 30;

/** 最终执行结果 */
export interface ExecuteResult {
  /** 执行日志，记录每一步的操作和结果 */
  execution_log: string;
  /** 每个任务的执行状态 */
  task_status: Record<string, "success" | "failed" | "skipped">;
  /** 是否完全成功 */
  success: boolean;
}

// ================================================================
// System Prompt for the Execute LLM
// 这个 Prompt 定义了 LLM 作为"智能操作员"的行为准则
// ================================================================
const EXECUTE_SYSTEM_PROMPT = `你是一个文档操作的**智能执行专家**。你**已经拥有**直接调用文档操作工具的能力，不需要任何外部服务或工具。

【重要！你必须知道的工具清单】
以下 5 个工具已在你手中，直接调用即可，无需联网、无需第三方 API：
1. sdk_get_text() — ★★★ 核心工具！用于读取文档全文。对于"总结/分析/提取/翻译/查找"等需要理解文档内容的任务，必须**先调用此工具**获取内容，然后自行分析
2. sdk_find_text(pattern) — 在文档中查找指定文本，返回匹配位置
3. sdk_replace_text(target, replacement) — 替换第一个匹配的文本
4. sdk_replace_all(target, replacement) — 替换所有匹配的文本
5. sdk_save() — 保存文档修改

【通用执行策略】

🔥 场景一：需要理解文档内容的任务（总结、分析、提取、翻译、查找信息）
→ 第 1 步：调用 sdk_get_text() 获取全文
→ 第 2 步：阅读获取到的文本内容
→ 第 3 步：直接基于内容完成总结/分析/回答
→ 不需要任何外部工具，你的 LLM 能力就是处理文本的最佳工具！

🔥 场景二：替换/修改文本的任务
→ 第 1 步：调用 sdk_find_text 确认目标文本是否存在、在什么位置
→ 第 2 步：调用 sdk_replace_text 或 sdk_replace_all 执行替换
→ 第 3 步：调用 sdk_get_text 验证结果

🔥 场景三：设置格式的任务（加粗、改颜色等，暂未实现对应工具）
→ 由于格式工具暂未开放，遇到此类任务请记录为"格式操作未实现"

【异常处理】
- sdk_find_text 找不到目标：尝试更短的词、去掉标点、考虑可能的漏字
- sdk_replace_text 失败：记录失败原因，继续下一个任务
- 连续失败 3 次：跳过该任务，标记为 failed

【输出要求】
1. 每完成一个操作，用中文记录操作内容和结果
2. 所有任务完成后，汇总任务执行情况
3. 全部完成时务必调用 sdk_save() 保存文档`;

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

    // 解析任务清单
    let tasks: any[] = [];
    try {
      const planOutput = JSON.parse(input.plan_tasks);
      tasks = planOutput.tasks || [];
    } catch {
      return JSON.stringify({
        execution_log: "[Execute] 错误: 无法解析 plan_tasks JSON",
        task_status: {},
        success: false,
      } as ExecuteResult);
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
    const messages: any[] = [
      new SystemMessage(EXECUTE_SYSTEM_PROMPT),
      new HumanMessage(
        `请按以下任务清单操作文档（文档ID: ${this.docId}）：\n\n` +
        JSON.stringify(tasks, null, 2) +
        `\n\n请逐个执行任务，每完成一步告诉我结果。所有任务完成后调用 sdk_save。`
      ),
    ];

    const log: string[] = [];
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
            log.push(`[工具] ${toolName}(${JSON.stringify(toolArgs)}) → ${result.toString().slice(0, 200)}`);

            // 记录任务状态：如果是 sdk_replace_text 或 sdk_replace_all，标记对应任务
            if (toolName === "sdk_replace_text" || toolName === "sdk_replace_all") {
              // 查找当前正在执行的任务（根据日志推断）
              const taskMatch = response.content?.toString().match(/任务[：:]\s*([^\n]+)/);
              if (taskMatch) {
                taskStatus[taskMatch[1]] = "success";
              }
            }

            // 将工具执行结果返回给 LLM
            messages.push(new ToolMessage({
              content: typeof result === "string" ? result : JSON.stringify(result),
              tool_call_id: toolId!,
            }));
          } catch (err: any) {
            const errMsg = `[工具] ${toolName} 执行失败: ${err.message}`;
            log.push(errMsg);
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
