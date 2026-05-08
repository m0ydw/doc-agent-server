/**
 * ================================================================
 * LangGraph 工作流图定义
 * ================================================================
 *
 * 节点拓扑（6 阶段 + Plan 校验）：
 *   analyze → plan → validate_plan → (valid) → execute → generate → validate → decide
 *                       (invalid & retries<2) → plan (重试)
 *                       (invalid & retries>=2) → execute (兜底)
 */

import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { PhaseStreamStrategy } from "../agent/phaseStrategy";
import { AgentState } from "./state";
import {
  createAnalyzeNode,
  createPlanNode,
  createValidatePlanNode,
  createExecuteNode,
  createGenerateNode,
  createValidateNode,
} from "./nodes";

export function createWorkflow(llm: ChatOpenAI, strategy: PhaseStreamStrategy) {
  const analyze = createAnalyzeNode(llm, strategy);
  const plan = createPlanNode(llm, strategy);
  const validatePlan = createValidatePlanNode(llm);
  const execute = createExecuteNode(llm);
  const generate = createGenerateNode(llm);
  const validate = createValidateNode(llm, strategy);

  const workflow = new StateGraph(AgentState)
    .addNode("analyze", analyze)
    .addNode("plan", plan)
    .addNode("validate_plan", validatePlan)
    .addNode("execute", execute)
    .addNode("generate", generate)
    .addNode("validate", validate)

    .addEdge("__start__", "analyze")
    .addEdge("analyze", "plan")
    .addEdge("plan", "validate_plan")
    .addConditionalEdges("validate_plan", decidePlanNext)
    .addEdge("execute", "generate")
    .addEdge("generate", "validate")
    .addConditionalEdges("validate", decideNextStep);

  return workflow.compile();
}

function decidePlanNext(state: typeof AgentState.State): string {
  if (state.planValid) return "execute";
  if (state.planRetries < 2) return "plan";
  return "execute"; // 兜底：重试 2 次后不再纠结
}

function decideNextStep(state: typeof AgentState.State): string {
  if (state.success) return END;
  if (state.needsUserInput) return END;
  if (!state.retryable) return END;
  if (state.retryCount >= state.maxRetry) return END;
  return "analyze";
}
