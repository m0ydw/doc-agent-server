/**
 * ================================================================
 * LangGraph 多 Agent 工作流图（Supervisor 模式）
 *
 * 【节点拓扑】
 *   orchestrator → conditional(按 agentPlan 路由) →
 *     ├── doc_analyst     ──→ supervisor_router
 *     ├── surgical_editor ──→ supervisor_router
 *     ├── template_filler ──→ supervisor_router
 *     └── reviewer        ──→ supervisor_router
 *
 *   supervisor_router:
 *     ├── agentPlan 未完成 → 路由到下一个 Agent
 *     └── agentPlan 已完成 → END
 *
 * 【Supervisor 模式说明】
 * 这是 LangGraph 推荐的标准 Supervisor 多 Agent 模式。
 * 不是简单的线性管道，而是由一个 Supervisor Router 在每次节点完成后
 * 动态决策下一个要执行的 Agent 节点。
 *
 * 【为什么用 conditional edges？】
 * 每个 Agent 节点执行完毕后，都需要 supervisorRouter 根据 agentPlan
 * 和当前 delegationStep 决定：继续执行下一个 Agent，还是结束工作流。
 * 这实现了动态、可扩展的多 Agent 编排。
 *
 * 【LLM 实例共享】
 * 所有节点共用同一个 ChatOpenAI 实例，以保证：
 * - API Key 统一管理
 * - 速率限制共用
 * - 温度等参数一致性
 * 各节点的微决策差异通过各自的 prompt 模板实现。
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

/** agentPlan 中单个委派条目的类型定义 */
interface AgentDelegation {
  /** Agent 名称：doc_analyst / surgical_editor / template_filler / reviewer */
  agent: string;
  /** 输入参数（可选） */
  input?: Record<string, unknown>;
  /** 依赖的前置步骤索引（用于保证执行顺序） */
  dependsOn?: number;
}

/**
 * 创建工作流图（对外唯一入口）
 *
 * 【调用时机】wsAgentHandler 在收到 workflow 模式的 agent_message 时调用
 *
 * 【构建步骤】
 * 1. 创建各 Agent 节点（每个节点返回一个 async 函数）
 * 2. 注册节点到 StateGraph
 * 3. 设置图边：
 *    - __start__ → orchestrator（入口）
 *    - orchestrator → supervisorRouter（条件路由）
 *    - 每个 Agent → supervisorRouter（条件路由）
 * 4. 编译图（返回可执行的 CompiledStateGraph）
 *
 * 【为什么 TemplateFiller 不需要 LLM？】
 * TemplateFiller 是纯确定性节点：数据已提取、映射已建立，
 * 写入操作通过 fieldMappings 和 DataGuard 完成，不需要 LLM 参与决策。
 *
 * @param llm 共享的 ChatOpenAI LLM 实例
 * @returns 编译后的可执行工作流图
 */
export function createWorkflow(llm: ChatOpenAI) {
  // 使用同一个 LLM 实例（微决策由 prompt 中的 temperature 约束控制）
  // ChatOpenAI 在构造函数中已设置 temperature，此处直接复用

  // 创建各节点函数
  const orchestrator = createOrchestratorNode(llm);
  const docAnalyst = createDocAnalystNode(llm);
  const surgicalEditor = createSurgicalEditorNode(llm);
  const templateFiller = createTemplateFillerNode(); // 纯确定性，不需要 LLM
  const reviewer = createReviewerNode(llm);

  const workflow = new StateGraph(AgentState)
    // 注册节点
    .addNode("orchestrator", orchestrator)
    .addNode("doc_analyst", docAnalyst)
    .addNode("surgical_editor", surgicalEditor)
    .addNode("template_filler", templateFiller)
    .addNode("reviewer", reviewer)

    // 入口边：工作流启动时从 orchestrator 开始
    .addEdge("__start__", "orchestrator")

    // orchestrator → supervisor_router（根据 agentPlan 决定第一个 Agent）
    .addConditionalEdges("orchestrator", supervisorRouter, [
      "doc_analyst",
      "surgical_editor",
      "template_filler",
      "reviewer",
      END,
    ])

    // 各 Agent → supervisor_router（每个 Agent 完成后重新路由）
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
 * Supervisor 路由器：根据 agentPlan 和 delegationStep 决定下一步路由
 *
 * 【工作原理】
 * 1. 从 state.planJson 中解析 agentPlan 数组
 * 2. 使用 state.delegationStep 作为当前步骤索引
 * 3. 如果所有步骤已完成（索引 >= 数组长度）→ END（工作流结束）
 * 4. 否则 → 路由到 agentPlan[currentStep].agent 对应的节点
 *
 * 【delegationStep 自增机制】
 * 每个 Agent 节点执行完毕后会在 state 更新中自增 delegationStep。
 * 路由到相应 Agent → 该 Agent 执行 → agent 返回时 delegationStep + 1 →
 * supervisorRouter 再次被调用 → 检查下一个步骤或结束。
 *
 * 【为什么每个 Agent 后都连接 supervisorRouter？】
 * 这是 Supervisor 模式的精髓：不是预先硬编码线性流程，
 * 而是每次 Agent 完成后动态决策。这允许：
 * - 根据前一步结果动态调整后续步骤
 * - 插入或跳过 Agent
 * - 循环重试失败的步骤
 *
 * @param state 当前工作流状态
 * @returns 下一个目标的节点名称或 END
 */
function supervisorRouter(state: typeof AgentState.State): string {
  let agentPlan: AgentDelegation[] = [];

  try {
    const planData = JSON.parse(state.planJson);
    agentPlan = planData.agentPlan || [];
  } catch {
    return END; // 无有效计划 → 结束工作流
  }

  if (agentPlan.length === 0) {
    return END;
  }

  // delegationStep 已经在各 Agent 节点中自增，此处直接读取索引
  const currentStep = state.delegationStep;

  // 检查是否所有步骤已完成
  if (currentStep >= agentPlan.length) {
    return END;
  }

  // 根据计划中的 agent 名称路由到对应节点
  const step = agentPlan[currentStep];
  const agentName = step.agent.toLowerCase();
  if (agentName === "doc_analyst") return "doc_analyst";
  if (agentName === "surgical_editor") return "surgical_editor";
  if (agentName === "template_filler") return "template_filler";
  if (agentName === "reviewer") return "reviewer";

  console.warn(`[SupervisorRouter] 未知 Agent: ${step.agent}, 跳过`);
  return END;
}
