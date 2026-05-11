/**
 * ================================================================
 * LangGraph 多 Agent 工作流图（Supervisor 模式）
 *
 * 节点拓扑：
 *   orchestrator → conditional(按 agentPlan 路由) →
 *     ├── doc_analyst     ──→ supervisor_router
 *     ├── surgical_editor ──→ supervisor_router
 *     ├── template_filler ──→ supervisor_router
 *     └── reviewer        ──→ supervisor_router
 *
 *   supervisor_router:
 *     ├── agentPlan 未完成 → 路由到下一个 Agent
 *     └── agentPlan 已完成 → generate → END
 *
 * 这是 LangGraph 推荐的标准 Supervisor 多 Agent 模式。
 * ================================================================
 */

import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { AgentState } from "./state";
import {
  createOrchestratorNode,
  createDocAnalystNode,
  createSurgicalEditorNode,
  createTemplateFillerNode,
  createReviewerNode,
} from "./nodes";

/** 根据 agentPlan 和 delegationStep 决定下一个 Agent */
interface AgentDelegation {
  agent: string;
  dependsOn?: number;
}

export function createWorkflow(llm: ChatOpenAI) {
  // 使用同一个 LLM 实例（微决策由 prompt 中的 temperature 约束控制）
  // ChatOpenAI 在构造函数中已设置 temperature，此处直接复用

  // 创建各节点
  const orchestrator = createOrchestratorNode(llm);
  const docAnalyst = createDocAnalystNode(llm);
  const surgicalEditor = createSurgicalEditorNode(llm);
  const templateFiller = createTemplateFillerNode(); // 纯确定性，不需要 LLM
  const reviewer = createReviewerNode(llm);

  const workflow = new StateGraph(AgentState)
    .addNode("orchestrator", orchestrator)
    .addNode("doc_analyst", docAnalyst)
    .addNode("surgical_editor", surgicalEditor)
    .addNode("template_filler", templateFiller)
    .addNode("reviewer", reviewer)

    // 入口 → orchestrator
    .addEdge("__start__", "orchestrator")

    // orchestrator → supervisor_router（决定第一个 Agent）
    .addConditionalEdges("orchestrator", supervisorRouter, [
      "doc_analyst",
      "surgical_editor",
      "template_filler",
      "reviewer",
      END,
    ])

    // 各 Agent → supervisor_router（决定下一个 Agent）
    .addConditionalEdges("doc_analyst", supervisorRouter, [
      "doc_analyst",
      "surgical_editor",
      "template_filler",
      "reviewer",
      END,
    ])
    .addConditionalEdges("surgical_editor", supervisorRouter, [
      "doc_analyst",
      "surgical_editor",
      "template_filler",
      "reviewer",
      END,
    ])
    .addConditionalEdges("template_filler", supervisorRouter, [
      "doc_analyst",
      "surgical_editor",
      "template_filler",
      "reviewer",
      END,
    ])
    .addConditionalEdges("reviewer", supervisorRouter, [
      "doc_analyst",
      "surgical_editor",
      "template_filler",
      "reviewer",
      END,
    ]);

  return workflow.compile();
}

/**
 * Supervisor 路由器：根据 agentPlan 和 delegationStep 决定下一步
 *
 * 规则：
 *   1. 解析 agentPlan
 *   2. 使用 delegationStep 作为当前步骤索引
 *   3. 如果所有步骤已完成 → generate
 *   4. 否则 → 路由到对应 Agent
 *
 * 注意：每个 Agent 节点返回时会自增 delegationStep，
 *       所以这里直接用 state.delegationStep 作为索引即可。
 */
function supervisorRouter(state: typeof AgentState.State): string {
  let agentPlan: AgentDelegation[] = [];

  try {
    const planData = JSON.parse(state.planJson);
    agentPlan = planData.agentPlan || [];
  } catch {
    return END; // 无有效计划 → 结束
  }

  if (agentPlan.length === 0) {
    return END;
  }

  // delegationStep 已经在各 Agent 节点中自增
  const currentStep = state.delegationStep;

  // 检查是否所有步骤已完成
  if (currentStep >= agentPlan.length) {
    return END;
  }

  // 路由到对应 Agent
  const step = agentPlan[currentStep];
  const agentName = step.agent.toLowerCase();
  if (agentName === "doc_analyst") return "doc_analyst";
  if (agentName === "surgical_editor") return "surgical_editor";
  if (agentName === "template_filler") return "template_filler";
  if (agentName === "reviewer") return "reviewer";

  console.warn(`[SupervisorRouter] 未知 Agent: ${step.agent}, 跳过`);
  return END;
}
