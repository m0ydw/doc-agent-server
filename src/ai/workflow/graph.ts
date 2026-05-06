/**
 * ================================================================
 * LangGraph 工作流图定义
 * ================================================================
 *
 * 节点拓扑：
 *   docTarget → analyze → plan → execute → generate → validate → decide
 *                                                                    │
 *                                            (success/needInput/!retryable) → END
 *                                            (retryable && retry < max) → analyze
 */

import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { PhaseStreamStrategy } from "../agent/phaseStrategy";
import { AgentState } from "./state";
import {
  createDocTargetNode,
  createAnalyzeNode,
  createPlanNode,
  createExecuteNode,
  createGenerateNode,
  createValidateNode,
} from "./nodes";

/**
 * 创建并编译 LangGraph 工作流
 */
export function createWorkflow(llm: ChatOpenAI, strategy: PhaseStreamStrategy) {
  const docTarget = createDocTargetNode(llm, strategy);
  const analyze = createAnalyzeNode(llm, strategy);
  const plan = createPlanNode(llm, strategy);
  const execute = createExecuteNode(llm);
  const generate = createGenerateNode(llm);
  const validate = createValidateNode(llm, strategy);

  const workflow = new StateGraph(AgentState)
    .addNode("docTarget", docTarget)
    .addNode("analyze", analyze)
    .addNode("plan", plan)
    .addNode("execute", execute)
    .addNode("generate", generate)
    .addNode("validate", validate)

    .addEdge("__start__", "docTarget")
    .addEdge("docTarget", "analyze")
    .addEdge("analyze", "plan")
    .addEdge("plan", "execute")
    .addEdge("execute", "generate")
    .addEdge("generate", "validate")
    .addConditionalEdges("validate", decideNextStep);

  return workflow.compile();
}

/**
 * 条件边决策：根据验证结果决定下一步
 */
function decideNextStep(state: typeof AgentState.State): string {
  if (state.success) return END;
  if (state.needsUserInput) return END;
  if (!state.retryable) return END;
  if (state.retryCount >= state.maxRetry) return END;
  return "analyze";
}
