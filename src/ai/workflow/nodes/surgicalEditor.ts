/**
 * SurgicalEditor（精准文本外科医生）节点
 *
 * 职责：执行轻量文本编辑任务（查找、替换、格式化）
 *
 * 【设计理念】"最少工具原则"
 * 只暴露 4 个文本操作工具，刻意不包含表格工具。
 * 这样 LLM 在简单替换任务中永远不会陷入"读表 → 猜坐标"的歧途。
 * 表格相关操作由 docAnalyst + templateFiller 专门处理。
 *
 * 【工具集（最小 4+1 个）】
 *   - sdk_find_text:     在文档中查找指定文本
 *   - sdk_replace_text:  替换第一个匹配
 *   - sdk_replace_all:   替换全部匹配
 *   - sdk_apply_format:  应用格式（粗体/斜体/下划线）
 *   - task_complete:     标记任务完成
 *
 * 【在整体流程中的位置】
 * 由 supervisorRouter 根据 agentPlan 调度。
 * 负责所有纯文本编辑和格式调整，不涉及表格结构分析。
 *
 * 【Tool Calling 循环】
 * LLM 通过 bindTools 绑定工具集，循环调用工具直到 task_complete。
 * 最多 10 轮（轻量编辑通常 2-3 轮即可完成）。
 */

import { ChatOpenAI } from "@langchain/openai";
import { StructuredTool } from "@langchain/core/tools";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../state";
import {
  SDKFindTextTool,
  SDKReplaceTextTool,
  SDKReplaceAllTool,
  SDKApplyFormatTool,
  SDKTaskCompleteTool,
} from "../../tools/sdkTools";
import { logLlmInvokeStart, logLlmInvokeResult } from "../../core/debugLogger";

// ================================================================
// 类型定义
// ================================================================

/** SurgicalEditor 节点接收的操作输入 */
export interface SurgicalEditorInput {
  operation: {
    /** 操作类型 */
    type: "find" | "replace" | "replace_all" | "format";
    /** 查找/替换的模式文本 */
    pattern?: string;
    /** 替换为目标文本 */
    replacement?: string;
    /** 格式操作参数 */
    format?: { bold?: "on" | "off"; italic?: "on" | "off"; underline?: "on" | "off" };
  };
}

// ================================================================
// System Prompt — 定义 LLM 在 Tool Calling 中的行为边界
//
// 关键约束：
// - 只能用 4 个指定工具，不要探索表格结构
// - 每步操作后用自然语言记录结果（不输出技术术语）
// - 所有任务完成后必须调用 task_complete()
// ================================================================

const SURGICAL_SYSTEM_PROMPT = `你是精准文本编辑专家。你只能使用以下 4 个工具：

1. sdk_find_text(文本) — 查找指定文本在文档中的位置
2. sdk_replace_text(原文本, 新文本) — 替换第一个匹配的文本
3. sdk_replace_all(原文本, 新文本) — 替换全部匹配的文本
4. sdk_apply_format(文本, 粗体?, 斜体?, 下划线?) — 对指定文本应用格式

【执行原则】
- 你的任务非常明确：查找指定文本，执行替换或格式化操作。
- 不要分析文档结构、不要探索表格、不要猜测用户意图。
- 很简单：找 → 替换/格式化 → task_complete

【数据写入规则】
- 严格按照任务描述中的文本进行操作
- 不要修改用户指定的替换目标或格式参数

【输出风格】
- 每步操作后用自然中文记录结果
- 不要复述文档具体内容
- 所有任务完成后调用 task_complete()

【输出禁止】
- 禁止出现 sdk_*、bindTools、invoke 等技术术语
- 禁止输出 JSON 结构或参数列表`;

// ================================================================
// 主节点实现 — LLM Tool Calling 循环
//
// 执行流程：
// 1. 从 agentPlan 中解析操作指令
// 2. 创建最小工具集并 bindTools 到 LLM
// 3. 进入 Tool Calling 循环（最多 10 轮）：
//    - LLM 决定调用哪个工具
//    - 执行工具并获取结果
//    - 将结果作为 ToolMessage 反馈给 LLM
//    - LLM 根据反馈决定下一步
//    - 遇到 task_complete 则退出循环
// 4. 返回执行结果
// ================================================================

/**
 * 创建 SurgicalEditor 节点函数
 *
 * @param llm 共享的 ChatOpenAI 实例
 */
export function createSurgicalEditorNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const logs: string[] = [];

    // 步骤1：从 agentPlan 中解析操作指令
    let operation: SurgicalEditorInput["operation"] | null = null;
    try {
      const planData = JSON.parse(state.planJson);
      const agentPlan = planData.agentPlan || [];
      const currentStep = state.delegationStep;
      if (agentPlan[currentStep]?.input?.operation) {
        operation = agentPlan[currentStep].input.operation;
      }
    } catch {
      // 解析失败时不设置 operation，LLM 会从 userInput 中自行推断
    }

    // 步骤2：初始化最小工具集（每个工具实例绑定到 docId）
    const tools: StructuredTool[] = [
      new SDKFindTextTool(docId),
      new SDKReplaceTextTool(docId),
      new SDKReplaceAllTool(docId),
      new SDKApplyFormatTool(docId),
      new SDKTaskCompleteTool(),
    ];

    // bindTools 将工具集绑定到 LLM，使 LLM 在需要时自动发出 tool_call
    const llmWithTools = llm.bindTools(tools);

    // 步骤3：构建初始消息
    const messages: Array<SystemMessage | HumanMessage | AIMessage | ToolMessage> = [
      new SystemMessage(SURGICAL_SYSTEM_PROMPT),
      new HumanMessage(
        `请对文档执行以下操作：\n\n` +
        (operation ? JSON.stringify(operation, null, 2) : state.userInput) +
        `\n\n完成后调用 task_complete。`
      ),
    ];

    // 步骤4：Tool Calling 循环（最多 10 轮）
    const MAX_ROUNDS = 10;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const endLog = logLlmInvokeStart(`SurgicalEditor.round${round + 1}`);
      const response = await llmWithTools.invoke(messages);
      logLlmInvokeResult(`SurgicalEditor.round${round + 1}`, response.content?.toString() || null, response.tool_calls);
      endLog?.();
      messages.push(response);

      // LLM 返回了工具调用请求
      if (response.tool_calls && response.tool_calls.length > 0) {
        let shouldBreak = false;
        for (const tc of response.tool_calls) {
          // 遇到 task_complete → 退出循环（任务完成）
          if (tc.name === "task_complete") {
            logs.push("[SurgicalEditor] 编辑完成");
            shouldBreak = true;
            break;
          }

          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) {
            messages.push(new ToolMessage({
              content: `未知工具: ${tc.name}`,
              tool_call_id: tc.id!,
            }));
            continue;
          }

          // 执行工具调用
          try {
            const result = await tool.invoke(tc.args);
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            logs.push(`[${tc.name}] ${resultStr.slice(0, 200)}`);

            // 将工具结果反馈给 LLM（ToolMessage）
            messages.push(new ToolMessage({
              content: resultStr,
              tool_call_id: tc.id!,
            }));
          } catch (err: unknown) {
            const errMsg = `操作失败: ${(err as Error).message}`;
            logs.push(`[${tc.name}] ${errMsg}`);

            messages.push(new ToolMessage({
              content: errMsg,
              tool_call_id: tc.id!,
            }));
          }
        }
        if (shouldBreak) break;
      } else {
        // 无工具调用：LLM 可能在生成思考文本
        // 接近最大轮数时强制终止（避免死循环）
        if (round >= MAX_ROUNDS - 2) {
          logs.push("[SurgicalEditor] 达到最大轮数，强制终止");
          break;
        }
      }
    }

    return {
      executionLog: state.executionLog + "\n" + logs.join("\n"),
      delegationStep: (state.delegationStep ?? 0) + 1,
      success: true,
      lastAgent: "SurgicalEditor",
    };
  };
}
