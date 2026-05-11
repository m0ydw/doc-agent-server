/**
 * Orchestrator（总调度）节点
 *
 * 职责：
 *   1. 理解用户意图
 *   2. 判断任务类型
 *   3. 制定委派计划（agentPlan）
 *   4. 触发 DataExtractor（如需要）
 *
 * 工具集：无（不直接操作文档）
 * LLM 角色：意图分类 + 委派决策
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../state";
import { orchestratorSystemPrompt, orchestratorHumanTemplate } from "../../prompts/orchestrator";
import { extractStructuredData } from "../../modules/dataExtractor";
import { KNOWN_FIELDS } from "../../modules/fieldConfig";
import { logLlmInvokeStart, logLlmInvokeResult } from "../../core/debugLogger";

// ================================================================
// 类型
// ================================================================

interface AgentDelegation {
  agent: string;
  input?: Record<string, unknown>;
  dependsOn?: number;
}

interface OrchestratorOutput {
  intent: string;
  taskType: "simple_edit" | "complex_fill" | "query" | "format_change" | "mixed";
  agentPlan: AgentDelegation[];
}

// ================================================================
// 主节点实现
// ================================================================

export function createOrchestratorNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const logs: string[] = [];
    let orchestratorOutput: OrchestratorOutput | null = null;
    let extractedDataStr = state.extractedData;

    try {
      // 构建 prompt
      const systemMessages = await orchestratorSystemPrompt.formatMessages({});
      const humanMessages = await orchestratorHumanTemplate.formatMessages({
        user_input: state.userInput,
        doc_context: state.docContext,
        target_doc: state.targetDocName || state.docId || "未指定",
      });

      const messages = [
        systemMessages[0],
        humanMessages[0],
      ];

      // LLM 调用
      const endLog = logLlmInvokeStart("Orchestrator");
      const response = await llm.invoke(messages);
      logLlmInvokeResult("Orchestrator", response.content?.toString() || null, undefined);
      endLog?.();

      const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

      // 提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          orchestratorOutput = JSON.parse(jsonMatch[0]) as OrchestratorOutput;
        } catch {
          logs.push("[Orchestrator] JSON 解析失败，使用降级策略");
        }
      }

      // 降级策略：如果 LLM 未产出有效输出，用规则判断
      if (!orchestratorOutput || !orchestratorOutput.agentPlan?.length) {
        orchestratorOutput = fallbackClassification(state.userInput, state.docId);
        logs.push("[Orchestrator] 使用降级分类策略");
      }

      // 确保 agentPlan 有效
      if (!orchestratorOutput.agentPlan) {
        orchestratorOutput.agentPlan = [];
      }

      logs.push(
        `[Orchestrator] 意图: ${orchestratorOutput.intent}, ` +
        `类型: ${orchestratorOutput.taskType}, ` +
        `委派: ${orchestratorOutput.agentPlan.map((a) => a.agent).join(" → ")}`
      );

      // 如果是填表任务，触发 DataExtractor
      if (orchestratorOutput.taskType === "complex_fill") {
        const extractResult = await extractStructuredData(llm, state.userInput, KNOWN_FIELDS);
        extractedDataStr = JSON.stringify(extractResult.data);
        logs.push(`[Orchestrator] DataExtractor: ${Object.keys(extractResult.data).length} 个字段, 覆盖率: ${Math.round(extractResult.coverage * 100)}%, 方法: ${extractResult.method}`);
      }

    } catch (err) {
      logs.push(`[Orchestrator] 异常: ${(err as Error).message}`);
      orchestratorOutput = fallbackClassification(state.userInput, state.docId);
    }

    return {
      analysis: JSON.stringify(orchestratorOutput),
      planJson: JSON.stringify({ agentPlan: orchestratorOutput?.agentPlan || [] }),
      extractedData: extractedDataStr,
      executionLog: state.executionLog + "\n" + logs.join("\n"),
      delegationStep: 0,
      lastAgent: "Orchestrator",
    };
  };
}

// ================================================================
// 降级分类（规则驱动，不依赖 LLM）
// ================================================================

function fallbackClassification(userInput: string, docId: string): OrchestratorOutput {
  const input = userInput.toLowerCase();

  // 简单替换
  if (
    input.includes("替换") || input.includes("改成") || input.includes("换成") ||
    input.includes("改错") || input.includes("修正") || input.includes("错别字")
  ) {
    return {
      intent: "文本替换",
      taskType: "simple_edit",
      agentPlan: [{ agent: "surgical_editor", input: {} }],
    };
  }

  // 填表
  if (
    input.includes("填表") || input.includes("填入") || input.includes("填充") ||
    input.includes("模板") || (input.includes("姓名") && input.includes("电话"))
  ) {
    return {
      intent: "模板填充",
      taskType: "complex_fill",
      agentPlan: [
        { agent: "doc_analyst", input: { role: "target" } },
        { agent: "template_filler", input: {}, dependsOn: 0 },
        { agent: "reviewer", input: {}, dependsOn: 1 },
      ],
    };
  }

  // 查询
  if (
    input.includes("查") || input.includes("看") || input.includes("有什么") ||
    input.includes("内容") || input.includes("写了什么") || input.endsWith("?") ||
    input.endsWith("？")
  ) {
    return {
      intent: "内容查询",
      taskType: "query",
      agentPlan: [{ agent: "doc_analyst", input: { role: "target" } }],
    };
  }

  // 格式调整
  if (
    input.includes("加粗") || input.includes("斜体") || input.includes("下划线") ||
    input.includes("字号") || input.includes("字体") || input.includes("格式")
  ) {
    return {
      intent: "格式调整",
      taskType: "format_change",
      agentPlan: [{ agent: "surgical_editor", input: {} }],
    };
  }

  // 默认：复杂任务（先分析文档，再操作）
  return {
    intent: "混合操作",
    taskType: "mixed",
    agentPlan: [
      { agent: "doc_analyst", input: { role: "target" } },
      { agent: "surgical_editor", input: {}, dependsOn: 0 },
    ],
  };
}
