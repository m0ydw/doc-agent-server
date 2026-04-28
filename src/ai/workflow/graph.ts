/**
 * ================================================================
 * LangGraph 工作流图定义
 * ================================================================
 *
 * 【节点拓扑】
 *   START → analyze → plan → execute → validate → remember → END
 *                                                    │
 *                                        (失败且可重试)│
 *                                                   ↓
 *                                                analyze (重试)
 *
 * 【条件边逻辑（remember 节点之后）】
 *   1. success = true       → 成功，结束
 *   2. needs_user_input     → 需要用户介入，结束
 *   3. !retryable           → 不可重试错误，结束
 *   4. retry >= max_retry   → 重试耗尽，结束
 *   5. 否则                → 回到 analyze 重试
 * ================================================================
 */

import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { AgentState } from "./state";
import {
  createAnalyzeNode,
  createPlanNode,
  createExecuteNode,
  createValidateNode,
  createRememberNode,
} from "./nodes";

/**
 * 创建并编译 LangGraph 工作流
 *
 * @param llm - ChatOpenAI 实例，所有 LLM 节点共享
 * @returns 编译后的可执行图
 */
export function createWorkflow(llm: ChatOpenAI) {
  // 创建所有节点函数
  const analyzeNode = createAnalyzeNode(llm);
  const planNode = createPlanNode(llm);
  const executeNode = createExecuteNode(llm);
  const validateNode = createValidateNode(llm);
  const rememberNode = createRememberNode();

  // 构建有向图
  const workflow = new StateGraph(AgentState)
    // 注册节点
    .addNode("analyze", analyzeNode)
    .addNode("plan", planNode)
    .addNode("execute", executeNode)
    .addNode("validate", validateNode)
    .addNode("remember", rememberNode)
    // 固定边
    .addEdge("__start__", "analyze")
    .addEdge("analyze", "plan")
    .addEdge("plan", "execute")
    .addEdge("execute", "validate")
    .addEdge("validate", "remember")
    // 条件边：根据执行结果决定下一步
    .addConditionalEdges("remember", decideNextStep);

  // 编译为可执行图
  return workflow.compile();
}

/**
 * 条件边决策函数
 * 在 remember 节点之后调用，决定继续重试还是结束
 *
 * @param state - 当前工作流状态
 * @returns 下一个节点名或 END
 */
function decideNextStep(state: typeof AgentState.State): string {
  // 情况1: 执行成功
  if (state.success) {
    console.log(`[工作流] 执行成功，结束 (重试 ${state.retry_count}/${state.max_retry})`);
    return END;
  }

  // 情况2: 需要用户介入
  if (state.needs_user_input) {
    console.log(`[工作流] 需要用户介入，结束`);
    return END;
  }

  // 情况3: 不可重试的错误
  if (!state.retryable) {
    console.log(`[工作流] 不可重试错误，结束`);
    return END;
  }

  // 情况4: 重试次数耗尽
  if (state.retry_count >= state.max_retry) {
    console.log(`[工作流] 重试 ${state.max_retry} 次耗尽，结束`);
    return END;
  }

  // 情况5: 继续重试
  console.log(`[工作流] 重试第 ${state.retry_count + 1}/${state.max_retry} 次`);
  return "analyze";
}
