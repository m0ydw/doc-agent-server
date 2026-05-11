/**
 * SurgicalEditor（精准文本外科医生）节点
 *
 * 职责：执行轻量文本编辑任务（查找、替换、格式化）
 *
 * 工具集（最小 4 个）：
 *   - sdk_find_text
 *   - sdk_replace_text
 *   - sdk_replace_all
 *   - sdk_apply_format
 *
 * 特点：看不到表格工具，永远不会在简单替换时陷入"读表→猜坐标"的歧途。
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
// 类型
// ================================================================

export interface SurgicalEditorInput {
  operation: {
    type: "find" | "replace" | "replace_all" | "format";
    pattern?: string;
    replacement?: string;
    format?: { bold?: "on" | "off"; italic?: "on" | "off"; underline?: "on" | "off" };
  };
}

// ================================================================
// System Prompt
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
// 主节点实现
// ================================================================

export function createSurgicalEditorNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const logs: string[] = [];

    // 解析任务
    let operation: SurgicalEditorInput["operation"] | null = null;
    try {
      const planData = JSON.parse(state.planJson);
      const agentPlan = planData.agentPlan || [];
      const currentStep = state.delegationStep;
      if (agentPlan[currentStep]?.input?.operation) {
        operation = agentPlan[currentStep].input.operation;
      }
    } catch {
      // 从 executionLog 中推断操作
    }

    // 初始化最小工具集
    const tools: StructuredTool[] = [
      new SDKFindTextTool(docId),
      new SDKReplaceTextTool(docId),
      new SDKReplaceAllTool(docId),
      new SDKApplyFormatTool(docId),
      new SDKTaskCompleteTool(),
    ];

    const llmWithTools = llm.bindTools(tools);

    // 构建消息
    const messages: Array<SystemMessage | HumanMessage | AIMessage | ToolMessage> = [
      new SystemMessage(SURGICAL_SYSTEM_PROMPT),
      new HumanMessage(
        `请对文档执行以下操作：\n\n` +
        (operation ? JSON.stringify(operation, null, 2) : state.userInput) +
        `\n\n完成后调用 task_complete。`
      ),
    ];

    // Tool calling 循环（最多 10 轮，轻量编辑）
    const MAX_ROUNDS = 10;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const endLog = logLlmInvokeStart(`SurgicalEditor.round${round + 1}`);
      const response = await llmWithTools.invoke(messages);
      logLlmInvokeResult(`SurgicalEditor.round${round + 1}`, response.content?.toString() || null, response.tool_calls);
      endLog?.();
      messages.push(response);

      if (response.tool_calls && response.tool_calls.length > 0) {
        let shouldBreak = false;
        for (const tc of response.tool_calls) {
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

          try {
            const result = await tool.invoke(tc.args);
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            logs.push(`[${tc.name}] ${resultStr.slice(0, 200)}`);

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
        // 无工具调用，LLM 可能思考中
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
