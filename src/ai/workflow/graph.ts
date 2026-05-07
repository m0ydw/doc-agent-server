/**
 * ================================================================
 * LangGraph 工作流图定义
 * ================================================================
 *
 * 节点拓扑（5 阶段，LLM 自行决定目标文档）：
 *   analyze → plan → execute → generate → validate → decide
 *                                                        │
 *                                (success/needInput/!retryable) → END
 *                                (retryable && retry < max) → analyze
 */

import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { PhaseStreamStrategy } from "../agent/phaseStrategy";
import { AgentState } from "./state";
import {
  createAnalyzeNode,
  createPlanNode,
  createExecuteNode,
  createGenerateNode,
  createValidateNode,
} from "./nodes";

export function createWorkflow(llm: ChatOpenAI, strategy: PhaseStreamStrategy) {
  const analyze = createAnalyzeNode(llm, strategy);
  const plan = createPlanNode(llm, strategy);
  const execute = createExecuteNode(llm);
  const generate = createGenerateNode(llm);
  const validate = createValidateNode(llm, strategy);

  const workflow = new StateGraph(AgentState)
    .addNode("analyze", analyze)
    .addNode("plan", plan)
    .addNode("execute", execute)
    .addNode("generate", generate)
    .addNode("validate", validate)

    .addEdge("__start__", "analyze")
    .addEdge("analyze", "plan")
    .addEdge("plan", "execute")
    .addEdge("execute", "generate")
    .addEdge("generate", "validate")
    .addConditionalEdges("validate", decideNextStep);

  return workflow.compile();
}

function decideNextStep(state: typeof AgentState.State): string {
  if (state.success) return END;
  if (state.needsUserInput) return END;
  if (!state.retryable) return END;
  if (state.retryCount >= state.maxRetry) return END;
  return "analyze";
}
