/**
 * ================================================================
 * LangGraph 多 Agent 工作流图（Supervisor 模式）
 * ================================================================
 *
 * 【节点拓扑】
 *   orchestrator → conditional(按 agentPlan 路由) →
 *     ├── doc_analyst        ──→ supervisor_router
 *     ├── execution_planner  ──→ supervisor_router
 *     ├── document_filler    ──→ supervisor_router
 *     └── reviewer           ──→ supervisor_router
 *
 *   supervisor_router:
 *     ├── agentPlan 未完成 → 路由到下一个 Agent
 *     └── agentPlan 已完成 → END
 */

import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { AgentState } from "./state";
import {
  createOrchestratorNode,
  createDocAnalystNode,
  createExecutionPlannerNode,
  createDocumentFillerNode,
} from "./nodes";
import { ExecutionPlanSchema, normalizeExecutionPlan } from "./nodes/sharedSchemas";

/** agentPlan 中单个委派条目的类型定义 */
interface AgentDelegation {
  /** Agent 名称 */
  agent: string;
  /** 输入参数（可选） */
  input?: Record<string, unknown>;
  /** 依赖的前置步骤索引 */
  dependsOn?: number;
}

/**
 * 创建工作流图（对外唯一入口）
 */
export function createWorkflow(llm: ChatOpenAI) {
  // 创建各节点函数
  const orchestrator = createOrchestratorNode(llm);
  const docAnalyst = createDocAnalystNode(llm);
  const executionPlanner = createExecutionPlannerNode(llm);
  const documentFiller = createDocumentFillerNode();

  const workflow = new StateGraph(AgentState)
    // 注册节点
    .addNode("orchestrator", orchestrator)
    .addNode("doc_analyst", docAnalyst)
    .addNode("execution_planner", executionPlanner)
    .addNode("document_filler", documentFiller)

    // 入口边：工作流启动时从 orchestrator 开始
    .addEdge("__start__", "orchestrator")

    // orchestrator → supervisor_router
    .addConditionalEdges("orchestrator", supervisorRouter, [
      "doc_analyst",
      "execution_planner",
      "document_filler",
      END,
    ])

    // 各 Agent → supervisor_router
    .addConditionalEdges("doc_analyst", supervisorRouter, [
      "doc_analyst",
      "execution_planner",
      "document_filler",
      END,
    ])
    .addConditionalEdges("execution_planner", supervisorRouter, [
      "doc_analyst",
      "execution_planner",
      "document_filler",
      END,
    ])
    .addConditionalEdges("document_filler", supervisorRouter, [
      "doc_analyst",
      "execution_planner",
      "document_filler",
      END,
    ]);

  return workflow.compile();
}

/**
 * Supervisor 路由器
 */
export function supervisorRouter(state: typeof AgentState.State): string {
  console.log("[Router] delegationStep:", state.delegationStep);
  if (state.needsUserInput || state.workflowError) {
    console.log("[Router] stopping due to workflowError/needsUserInput:", state.workflowError);
    return END;
  }
  if (state.docAnalystStatus === "failed") {
    console.log("[Router] stopping because doc_analyst failed");
    return END;
  }
  if (state.executionPlannerStatus === "failed") {
    console.log("[Router] stopping because execution_planner failed");
    return END;
  }
  let agentPlan: AgentDelegation[] = [];

  try {
    const planData = JSON.parse(state.planJson);
    agentPlan = planData.agentPlan || [];
  } catch {
    console.log("No valid plan");
    return END;
  }

  if (agentPlan.length === 0) {
    console.log("agentPlan.length === 0");
    return END;
  }

  const currentStep = state.delegationStep;

  // 检查是否所有步骤已完成
  if (currentStep >= agentPlan.length) {
    console.log(`${currentStep}>=${agentPlan.length}`);
    return END;
  }

  const step = agentPlan[currentStep];

  // 越界保护
  if (!step?.agent) {
    console.warn(`[SupervisorRouter] Invalid step at index ${currentStep}`);
    return END;
  }

  const agentName = normalizeAgentName(step.agent);
  if (agentName === "document_filler" && !hasValidExecutionPlan(state)) {
    console.log("[Router] stopping before document_filler because executionPlan is missing or invalid");
    return END;
  }

  // 支持的 Agent 列表
  const validAgents = [
    "doc_analyst",
    "execution_planner",
    "document_filler",
  ];

  if (validAgents.includes(agentName)) {
    return agentName;
  }

  console.warn(`[SupervisorRouter] Unknown Agent: ${step.agent}, skipping`);
  return END;
}

function hasValidExecutionPlan(state: typeof AgentState.State): boolean {
  if (!state.executionPlanId || !state.executionPlan || state.executionPlan === "{}") {
    return false;
  }

  try {
    const parsed = JSON.parse(state.executionPlan);
    return ExecutionPlanSchema.safeParse(normalizeExecutionPlan(parsed)).success;
  } catch {
    return false;
  }
}

function normalizeAgentName(agent: string): string {
  const key = agent.replace(/[\s_-]/g, "").toLowerCase();
  const aliases: Record<string, string> = {
    docanalyst: "doc_analyst",
    executionplanner: "execution_planner",
    documentfiller: "document_filler",
  };

  return aliases[key] || agent.toLowerCase();
}
