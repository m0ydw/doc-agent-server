/**
 * ================================================================
 * 工作流节点函数
 * ================================================================
 *
 * 每个节点是 LangGraph StateGraph 中的一个步骤。
 * 节点函数签名: (state: typeof AgentState.State) => Partial<typeof AgentState.State>
 *
 * 节点间通过 AgentState 共享数据。
 * 节点不应有副作用（除调用 LLM 和 SDK 外），所有输出写入 state。
 *
 * 【节点总览】
 *   analyze   →  LLM 分析用户需求，输出结构化意图
 *   plan      →  LLM 制定语义化任务清单
 *   execute   →  LLM 驱动执行（调用 SDK 工具）
 *   validate  →  LLM 验证执行结果
 *   remember  →  保存记忆到存储模块
 * ================================================================
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { AnalyzeTool, PlanTool, ExecuteTool, ValidateTool } from "../tools";
import { retrieveMemory, manageMemory } from "../core/memory";
import { AgentState } from "./state";

/**
 * ================================================================
 * 【Analyze 节点】— 需求分析
 * ================================================================
 *
 * ┌─ 职责 ──────────────────────────────────────────────────────────┐
 * │ 用 LLM 分析用户需求，输出结构化的操作意图。                       │
 * │ 只关心"用户想要什么"，不关心"具体怎么实现"。                     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 数据流 ────────────────────────────────────────────────────────┐
 * │ 输入: user_input + doc_context + related_memory                 │
 * │ 输出: analysis（JSON 字符串，含 intent/operations/context_hints）│
 * │ LLM 角色: "需求分析师"                                           │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function createAnalyzeNode(llm: ChatOpenAI) {
  const tool = new AnalyzeTool(llm);
  return async (state: typeof AgentState.State): Promise<Partial<typeof AgentState.State>> => {
    const analysis = await tool._call({
      user_input: state.user_input,
      related_memory: state.related_memory,
      doc_context: state.doc_context,
    });
    return { analysis };
  };
}

/**
 * ================================================================
 * 【Plan 节点】— 任务规划
 * ================================================================
 *
 * ┌─ 职责 ──────────────────────────────────────────────────────────┐
 * │ 根据分析结果，制定语义化的任务清单。                              │
 * │ 输出的是"要做什么"（goal/description/constraints），              │
 * │ 不是"怎么做"（action/params）。                                 │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 数据流 ────────────────────────────────────────────────────────┐
 * │ 输入: analysis + doc_context + related_memory                   │
 * │ 输出: plan（JSON 字符串，含 tasks[]/dependencies/failback）      │
 * │ LLM 角色: "项目经理"                                             │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 与旧版的区别 ─────────────────────────────────────────────────┐
 * │ 旧版输出: { steps: [{ action, params }] }   →  死指令          │
 * │ 新版输出: { tasks: [{ goal, description }] } →  语义化任务      │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function createPlanNode(llm: ChatOpenAI) {
  const tool = new PlanTool(llm);
  return async (state: typeof AgentState.State): Promise<Partial<typeof AgentState.State>> => {
    const plan = await tool._call({
      analysis: state.analysis,
      related_memory: state.related_memory,
      doc_context: state.doc_context,
    });
    return { plan };
  };
}

/**
 * ================================================================
 * 【Execute 节点】— LLM 驱动的智能执行
 * ================================================================
 *
 * ┌─ 职责 ──────────────────────────────────────────────────────────┐
 * │ 根据 Plan 的语义化任务清单，由 LLM 自主调用 SDK 工具完成操作。    │
 * │ LLM 决定"怎么做"——先做什么、用什么工具、失败了怎么办。            │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ LLM 输出 → SDK 调用 映射表 ──────────────────────────────────┐
 * │                                                                │
 * │  LLM 决策（自然语言）           SDK 调用（封装在 editor 中）    │
 * │  ──────────────────────         ─────────────────────           │
 * │  "查找'公司'出现在哪"          sdk_find_text("公司")            │
 * │                                  → editor.findText(docId, "公司")│
 * │                                    → doc.query.match(...)      │
 * │                                                                │
 * │  "把'公司'替换为'集团'"        sdk_replace_text("公司","集团") │
 * │                                  → editor.replaceFirst(...)    │
 * │                                    → doc.mutations.apply(...)  │
 * │                                                                │
 * │  "全部替换"                    sdk_replace_all("公司","集团")  │
 * │                                  → editor.replaceAll(...)      │
 * │                                    → doc.mutations.apply(...)  │
 * │                                                                │
 * │  "看看改完没"                  sdk_get_text()                  │
 * │                                  → editor.getText(docId)       │
 * │                                    → doc.getText()             │
 * │                                                                │
 * │  "保存"                        sdk_save()                      │
 * │                                  → sessionManager → doc.save() │
 * │                                                                │
 * │  LLM 通过 tool calling 调用 StructuredTool，                     │
 * │  工具内部调用 editor 的封装函数（已有的 SDK Agent）。             │
 * │  所有 SDK 调用都经过 editor 模块，不直接操作 doc 对象。          │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 异常处理 ────────────────────────────────────────────────────┐
 * │ 1. SDK 调用失败 → LLM 读取错误信息                              │
 * │ 2. LLM 参照 Plan 的 fallback_strategies                         │
 * │ 3. 尝试替代方案（模糊匹配、变体查找）                            │
 * │ 4. 记录失败原因到 execution_log                                 │
 * │ 5. 连续失败 3 次 → 跳过该任务                                   │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 协作同步 ────────────────────────────────────────────────────┐
 * │ editor 内部通过 sessionManager 连接到 Yjs 协作房间，            │
 * │ 所有 mutations.apply 操作实时同步到前端和 Python AI。           │
 * │ 不需要手动关注同步细节。                                        │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function createExecuteNode(llm: ChatOpenAI) {
  const tool = new ExecuteTool(llm);
  return async (state: typeof AgentState.State): Promise<Partial<typeof AgentState.State>> => {
    const execution_log = await tool._call({
      plan_tasks: state.plan,
      docId: state.docId,
    });
    return { execution_log };
  };
}

/**
 * ================================================================
 * 【Validate 节点】— 结果验证
 * ================================================================
 *
 * ┌─ 职责 ──────────────────────────────────────────────────────────┐
 * │ 用 LLM 验证执行结果是否符合预期。                                │
 * │ 判断成功/失败，决定是否可重试或需要用户介入。                    │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 数据流 ────────────────────────────────────────────────────────┐
 * │ 输入: execution_log + plan                                     │
 * │ 输出: validate_result（JSON）+ retryable + needs_user_input     │
 * │ LLM 角色: "质检员"                                              │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 判断逻辑 ────────────────────────────────────────────────────┐
 * │ retryable=true:    临时性问题（网络、超时、偶发错误）            │
 * │ retryable=false:   根本性问题（文档不存在、权限不足）            │
 * │ needs_user_input:  需要用户提供更多信息或确认                   │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function createValidateNode(llm: ChatOpenAI) {
  const tool = new ValidateTool(llm);
  return async (state: typeof AgentState.State): Promise<Partial<typeof AgentState.State>> => {
    const validateResultStr = await tool._call({
      execution_log: state.execution_log,
      plan_tasks: state.plan,
    });

    // 解析验证结果中的控制字段
    let retryable = true;
    let needs_user_input = false;
    let success = false;
    try {
      const parsed = JSON.parse(validateResultStr);
      retryable = parsed.retryable !== false;
      needs_user_input = parsed.needs_user_input === true;
      success = parsed.result === "成功";
    } catch {
      // 解析失败则保持默认值
    }

    return {
      validate_result: validateResultStr,
      retryable,
      needs_user_input,
      success,
    };
  };
}

/**
 * ================================================================
 * 【Remember 节点】— 保存记忆
 * ================================================================
 *
 * ┌─ 职责 ──────────────────────────────────────────────────────────┐
 * │ 将本次执行的历史记录保存到记忆模块，供后续操作参考。              │
 * │ 不调用 LLM，纯数据操作。                                        │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 数据流 ────────────────────────────────────────────────────────┐
 * │ 输入: 整个 state                                               │
 * │ 输出: 写入 memory 存储（不修改 state）                          │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function createRememberNode() {
  return async (state: typeof AgentState.State): Promise<Partial<typeof AgentState.State>> => {
    // 提取失败步骤
    const failedSteps = extractFailedSteps(state.execution_log);

    // 保存到记忆模块
    manageMemory(
      state.docId,
      state.user_input,
      state.retry_count,
      state.success ? "成功" : "失败",
      state.analysis,
      state.plan,
      state.execution_log,
      failedSteps
    );

    // 更新重试计数
    const newRetryCount = state.retry_count + 1;

    return {
      related_memory: retrieveMemory(state.docId, state.user_input),
      retry_count: newRetryCount,
    };
  };
}

/**
 * 从执行日志中提取失败步骤的辅助函数
 */
function extractFailedSteps(executionLog: string): string[] {
  const failed: string[] = [];
  const lines = executionLog.split("\n");
  for (const line of lines) {
    if (line.includes("失败") && line.includes("[工具]")) {
      const match = line.match(/\[工具\]\s*(\w+)/);
      if (match) {
        failed.push(match[1]);
      }
    }
  }
  return failed;
}
