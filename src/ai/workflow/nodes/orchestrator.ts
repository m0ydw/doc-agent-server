/**
 * Orchestrator（总调度）节点 — 工作流入口的第一个节点
 *
 * 职责：
 *   1. 理解用户意图（通过 LLM 分类）
 *   2. 判断任务类型（simple_edit / complex_fill / query / format_change / mixed）
 *   3. 制定委派计划（agentPlan：决定哪些 Agent 节点需要执行及顺序）
 *   4. 触发 DataExtractor（如果是填表任务，提前提取结构化数据）
 *
 * 【在整体流程中的位置】
 * 这是工作流图的入口节点。所有用户请求先到这里分类，
 * 再根据 agentPlan 由 supervisorRouter 调度后续 Agent 节点。
 * 此节点不直接操作文档，只负责决策和分配。
 *
 * 【工具集】无（不直接操作文档）
 * 【LLM 角色】意图分类 + 委派决策
 * 【降级策略】如果 LLM 未能产出有效输出，使用基于规则的 fallbackClassification()
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
// 类型定义
// ================================================================

/** agentPlan 中的单个委派条目 */
interface AgentDelegation {
  /** Agent 名称：surgical_editor / template_filler / doc_analyst / reviewer */
  agent: string;
  /** 输入参数（可选，如 doc_analyst 的 role） */
  input?: Record<string, unknown>;
  /** 依赖的前置步骤索引（确保执行顺序，如 template_filler 依赖 doc_analyst） */
  dependsOn?: number;
}

/** Orchestrator 节点的输出结构 */
interface OrchestratorOutput {
  /** 用户意图描述 */
  intent: string;
  /** 任务类型，决定后续的 AgentPlan 和 DataExtractor 触发 */
  taskType: "simple_edit" | "complex_fill" | "query" | "format_change" | "mixed";
  /** 委派的 Agent 列表及执行顺序 */
  agentPlan: AgentDelegation[];
}

// ================================================================
// 主节点实现
//
// 工作流程：
// 1. 构造 System + Human 消息（使用专用 prompt 模板）
// 2. 调用 LLM 获取意图分类结果
// 3. 从 LLM 输出中提取 JSON（降级策略保护）
// 4. 如果是填表任务 → 触发 DataExtractor 双阶段提取
// 5. 返回分析结果 + 委派计划 + 提取的数据
// ================================================================

/**
 * 创建 Orchestrator 节点函数
 *
 * 这是一个工厂函数，返回符合 LangGraph 节点签名的 async 函数。
 * 接收当前 state 返回 partial state update。
 *
 * @param llm 共享的 ChatOpenAI LLM 实例
 */
export function createOrchestratorNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const logs: string[] = [];
    let orchestratorOutput: OrchestratorOutput | null = null;
    let extractedDataStr = state.extractedData;

    try {
      // 步骤1：构造 LLM 消息（System Prompt + Human Template）
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

      // 步骤2：LLM 调用（带调试日志）
      const endLog = logLlmInvokeStart("Orchestrator");
      const response = await llm.invoke(messages);
      logLlmInvokeResult("Orchestrator", response.content?.toString() || null, undefined);
      endLog?.();

      const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

      // 步骤3：从 LLM 文本输出中提取 JSON（使用贪婪正则作第一次尝试）
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          orchestratorOutput = JSON.parse(jsonMatch[0]) as OrchestratorOutput;
        } catch {
          logs.push("[Orchestrator] JSON 解析失败，使用降级策略");
        }
      }

      // 步骤4：降级策略 — 如果 LLM 未产出有效输出，使用基于规则的关键词分类
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

      // 步骤5：如果是填表任务（complex_fill），触发双阶段数据提取
      // DataExtractor 从用户输入中提取结构化字段数据（如 姓名=张三）
      if (orchestratorOutput.taskType === "complex_fill") {
        const extractResult = await extractStructuredData(llm, state.userInput, KNOWN_FIELDS);
        extractedDataStr = JSON.stringify(extractResult.data);
        logs.push(`[Orchestrator] DataExtractor: ${Object.keys(extractResult.data).length} 个字段, 覆盖率: ${Math.round(extractResult.coverage * 100)}%, 方法: ${extractResult.method}`);
      }

    } catch (err) {
      // 异常兜底：使用规则分类
      logs.push(`[Orchestrator] 异常: ${(err as Error).message}`);
      orchestratorOutput = fallbackClassification(state.userInput, state.docId);
    }

    // 返回 partial state update（LangGraph 会自动合并到全局 state）
    return {
      analysis: JSON.stringify(orchestratorOutput),
      planJson: JSON.stringify({ agentPlan: orchestratorOutput?.agentPlan || [] }),
      extractedData: extractedDataStr,
      executionLog: state.executionLog + "\n" + logs.join("\n"),
      delegationStep: 0,  // 初始化委派步骤为 0
      lastAgent: "Orchestrator",
    };
  };
}

// ================================================================
// 降级分类器（基于规则的关键词匹配，不依赖 LLM）
//
// 当 LLM 调用失败或输出格式错误时，使用此函数作为兜底策略。
// 它通过中文关键词匹配判断用户意图并生成预定义的 agentPlan。
// 覆盖率有限但足够处理 80% 的常见场景。
// ================================================================

/**
 * 基于规则的降级分类函数
 *
 * 按优先级匹配中文关键词来决定任务类型和 agentPlan：
 * 1. 包含"替换/改成/改错/错别字" → simple_edit（直接 surgical_editor）
 * 2. 包含"填表/填入/模板/姓名" → complex_fill（doc_analyst → template_filler → reviewer）
 * 3. 包含"查/看/有什么/内容/?/？" → query（仅 doc_analyst）
 * 4. 包含"加粗/斜体/字号/字体/格式" → format_change（surgical_editor）
 * 5. 默认 → mixed（doc_analyst → surgical_editor）
 *
 * @param userInput 用户自然语言输入
 * @param docId 目标文档 ID（当前未在 plan 中使用，预留）
 * @returns 预定义的 OrchestratorOutput
 */
function fallbackClassification(userInput: string, docId: string): OrchestratorOutput {
  const input = userInput.toLowerCase();

  // 简单替换：直接走 surgical_editor 单节点
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

  // 填表任务：先分析文档结构 → 填充数据 → 验证
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

  // 查询：只分析文档，不做编辑
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

  // 格式调整：直接 surgical_editor
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

  // 默认：复杂任务（先分析文档结构，再执行编辑）
  return {
    intent: "混合操作",
    taskType: "mixed",
    agentPlan: [
      { agent: "doc_analyst", input: { role: "target" } },
      { agent: "surgical_editor", input: {}, dependsOn: 0 },
    ],
  };
}
