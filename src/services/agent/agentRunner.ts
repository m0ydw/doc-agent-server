/**
 * Agent 运行器 — 负责启动和执行 AI Agent 任务
 * 
 * 【核心职责】
 * 1. 创建 LLM 模型实例（当前支持 DeepSeek）
 * 2. 组装 Agent 工具集（读取、写入、验证等文档操作工具）
 * 3. 调用 Vercel AI SDK 的 streamText 函数执行流式对话
 * 4. 处理 Agent 执行过程中的各种事件（思考、工具调用、完成等）
 * 
 * 【Vercel AI SDK 核心概念】
 * - streamText: 启动一个流式文本生成任务，支持工具调用（function calling）
 * - stepCountIs: 定义 Agent 最大执行步数，防止无限循环
 * - tool: 定义一个工具，包含描述、参数 schema 和执行函数
 * - textStream: 异步迭代器，逐块返回生成的文本
 * 
 * 【Agent 执行流程】
 * 1. 用户发送 prompt → 2. LLM 分析任务 → 3. 决定调用哪个工具
 * 4. 执行工具并获取结果 → 5. 根据结果决定下一步（继续调用工具或返回最终答案）
 * 6. 重复 3-5 直到达到最大步数或任务完成
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, stepCountIs } from "ai";
import {
  addEvent,
  getRun,
  setRunStatus,
} from "./agentSessionManager";
import { saveSessionDocuments } from "../session";
import { createAgentTools } from "./agentTools";
import type { AgentEvent, AgentRun } from "./agentTypes";
import {
  logAgentStart,
  logUserInput,
  logSystemPrompt,
  logDocumentContext,
  logToolList,
  logStreamChunk,
  logStreamEnd,
  logStep,
  logAgentFinish,
  logAgentError,
  logFinalOutput,
  logToolCallDecision,
} from "./agentLogger";

/**
 * 事件发送函数类型
 * 用于将 Agent 事件实时推送给前端客户端
 * 
 * @param event - Agent 事件对象，包含类型、载荷、时间戳等
 */
type EmitToClient = (event: AgentEvent) => void;

function runHasWriteOperations(events: AgentEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "tool.finished" &&
      (event.payload.name === "write_cells_text" ||
        event.payload.name === "replace_text") &&
      event.payload.status === "ok",
  );
}

/**
 * Agent 系统提示词
 * 定义 Agent 的角色、能力范围和行为规范
 * 
 * 【提示词设计要点】
 * - 明确告知 Agent 它能做什么（读取、写入、验证等）
 * - 要求 Agent 在调用工具前说明计划（增加透明度）
 * - 规定写入前必须预演、写入后必须验证（安全机制）
 * - 处理 pending_approval 状态（人机协作机制）
 */
const SYSTEM_PROMPT = [
  "你是一个 DOCX 文档操作 Agent。",
  "你可以读取全文、查找文本、替换文本、检查表格、读取单元格、预演写入、写入单元格和验证结果。",
  "每次准备做工具调用前，用简短中文说明你当前的可见计划和下一步，不要输出隐藏思维链。",
  "除非用户明确要求，否则不要在回答中加入 emoji 或表情符号。",
  "面向用户的回答可以使用 Markdown 排版，但保持专业、简洁、可执行。",
  "写入前优先 dry_run_write_cells；写入后必须 verify_cells。",
  "如果写入或替换需要用户审批，工具会暂停到审批完成；审批结果返回后再继续判断和总结。",
  "工具 detail 可能很长，最终回答只总结关键结果。",
].join("\n");

/**
 * 构建文档上下文信息
 * 将当前可用的文档列表格式化为提示词，让 Agent 知道有哪些文档可操作
 * 
 * @param run - Agent 运行实例，包含文档列表和当前活跃文档
 * @returns 格式化的文档上下文字符串
 */
function buildDocumentContext(run: AgentRun): string {
  const documents = run.documents
    .map((doc, index) => {
      const active = doc.id === run.activeDocId ? "（当前）" : "";
      return `${index + 1}. ${doc.name}${active}`;
    })
    .join("\n");

  return [
    "当前可操作文档：",
    documents,
    "如果任务没有明确指定文档，默认使用标记为（当前）的文档。",
    "调用工具时优先使用 documentName 选择文档，不要向用户暴露内部文档 id。",
  ].join("\n");
}

/**
 * 发送 Agent 事件的辅助函数
 * 将事件记录到运行历史中，并实时推送给前端
 * 
 * 【事件驱动架构】
 * Agent 执行过程中会产生各种事件：
 * - agent.trace: 思考过程
 * - tool.started/tool.finished: 工具调用
 * - agent.message.delta: 流式文本片段
 * - approval.requested: 需要用户审批
 * - agent.finished/agent.error: 执行结束
 * 
 * @param runId - 运行实例 ID
 * @param type - 事件类型
 * @param payload - 事件载荷数据
 * @param send - 发送函数，将事件推送给客户端
 */
function emit(runId: string, type: AgentEvent["type"], payload: Record<string, unknown>, send: EmitToClient): void {
  const event = addEvent(runId, type, payload);
  send(event);
}

/**
 * 创建 DeepSeek LLM 模型实例
 * 
 * 【Vercel AI SDK 模型创建】
 * createOpenAICompatible: 创建一个兼容 OpenAI API 的模型提供者
 * - name: 提供者名称，用于日志和调试
 * - baseURL: API 端点地址
 * - apiKey: 认证密钥
 * - includeUsage: 是否包含 token 使用量统计
 * 
 * @param run - Agent 运行实例，包含 LLM 配置
 * @returns 模型实例，可传递给 streamText 使用
 */
function createDeepSeekModel(run: AgentRun) {
  if (run.llm.provider !== "deepseek") {
    throw new Error("第一版 Agent 只支持 DeepSeek provider");
  }
  if (!run.llm.apiKey) {
    throw new Error("缺少 DeepSeek API Key");
  }

  const provider = createOpenAICompatible({
    name: "deepseek",
    baseURL: run.llm.baseURL || "https://api.deepseek.com",
    apiKey: run.llm.apiKey,
    includeUsage: true,
  });
  return provider(run.llm.model || "deepseek-flash");
}

/**
 * 执行 Agent 任务的主函数
 * 
 * 【Vercel AI SDK streamText 函数详解】
 * streamText 是 AI SDK 的核心函数，用于启动一个流式文本生成任务
 * 
 * 参数说明：
 * @param model - LLM 模型实例（如 DeepSeek、OpenAI 等）
 * @param system - 系统提示词，定义 AI 的角色和行为规范
 * @param prompt - 用户输入的任务描述
 * @param tools - 工具集合，AI 可以调用这些工具完成任务
 * @param stopWhen - 停止条件，stepCountIs(8) 表示最多执行 8 步
 * @param temperature - 温度参数，控制生成的随机性（0-1，越低越确定）
 * 
 * 回调函数：
 * @param onStepStart - 每步开始时触发，stepNumber 从 0 开始
 * @param onFinish - 流式生成完成时触发，包含 finishReason 和 token 用量
 * 
 * 返回值：
 * @returns result 对象，包含：
 *   - textStream: 异步迭代器，逐块返回生成的文本
 *   - consumeStream(): 消费完整个流（必须调用以确保资源释放）
 * 
 * 【Agent 执行流程图】
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 用户输入 prompt                                              │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │ streamText 启动                                              │
 * │ 1. 将 system + prompt + tools 发送给 LLM                     │
 * │ 2. LLM 返回文本 + 可能的工具调用请求                          │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *              ┌───────────────┴───────────────┐
 *              ▼                               ▼
 * ┌─────────────────────────┐     ┌─────────────────────────────┐
 * │ LLM 返回纯文本           │     │ LLM 返回工具调用请求          │
 * │ → 通过 textStream 输出   │     │ → SDK 自动执行工具函数        │
 * └─────────────────────────┘     │ → 将工具结果发送给 LLM        │
 *                                 │ → LLM 决定下一步              │
 *                                 └─────────────────────────────┘
 *                                          │
 *                                          ▼
 *                                 ┌─────────────────────────────┐
 * │                               │ 重复上述过程                  │
 * │                               │ 直到：                       │
 * │                               │ - LLM 不再调用工具（返回纯文本）│
 * │                               │ - 达到最大步数（stepCountIs）  │
 * │                               │ - 用户取消任务                │
 * └───────────────────────────────┴─────────────────────────────┘
 * 
 * @param runId - Agent 运行实例 ID
 * @param send - 事件发送函数，用于实时推送进度给前端
 */
export async function runAgent(runId: string, send: EmitToClient): Promise<void> {
  const run = getRun(runId);
  if (!run) {
    throw new Error(`Agent run 不存在: ${runId}`);
  }

  try {
    // ========== 调试日志：Agent 开始 ==========
    logAgentStart(runId);
    logUserInput(run.prompt);

    // 发送初始 trace 事件，告知前端 Agent 开始执行
    emit(
      runId,
      "agent.trace",
      { text: "已接收任务，准备连接 DeepSeek 并选择 DOCX 工具。" },
      send,
    );

    // 创建 LLM 模型实例
    const model = createDeepSeekModel(run);

    // 创建工具集合
    // createAgentTools 返回一个对象，每个属性是一个工具定义
    // 工具定义包含：description（描述）、inputSchema（参数 schema）、execute（执行函数）
    const tools = createAgentTools(run, (type, payload) => {
      emit(runId, type, payload, send);
    });

    // ========== 调试日志：打印工具列表 ==========
    logToolList(tools as unknown as Record<string, unknown>);

    // 构建完整的系统提示词
    const fullSystemPrompt = `${SYSTEM_PROMPT}\n\n${buildDocumentContext(run)}`;

    // ========== 调试日志：打印 System Prompt 和文档上下文 ==========
    logSystemPrompt(SYSTEM_PROMPT);
    logDocumentContext(buildDocumentContext(run));

    // 用于收集每步的流式文本（在工具调用前输出的 LLM 思考文本）
    let stepTextBuffer = "";

    // 调用 streamText 启动流式对话
    // 这是整个 Agent 的核心：LLM + 工具 + 流式输出
    const result = streamText({
      model,                    // LLM 模型
      system: fullSystemPrompt, // 系统提示词 + 文档上下文
      prompt: run.prompt,       // 用户输入的任务描述
      tools,                    // 工具集合（LLM 可以调用这些工具）

      // stopWhen: 定义停止条件
      // stepCountIs(8) 表示最多执行 8 个"步骤"
      // 每个步骤 = LLM 生成一次响应（可能包含多个工具调用）
      // 这是防止 Agent 无限循环的安全机制
      stopWhen: stepCountIs(8),

      // temperature: 控制生成的随机性
      // 0.2 表示较低的随机性，适合需要精确操作的任务
      temperature: 0.2,

      // experimental_onStepStart: 每步开始时的回调
      // stepNumber 从 0 开始，这里 +1 是为了显示更友好的序号
      experimental_onStepStart: ({ stepNumber }) => {
        // ========== 调试日志：LLM 工具调用决策 ==========
        // 如果上一步有文本输出，说明是 LLM 调用工具前的思考/决策
        if (stepTextBuffer.trim()) {
          logToolCallDecision(stepTextBuffer);
        }

        // ========== 调试日志：步骤开始 ==========
        logStep(stepNumber);
        stepTextBuffer = ""; // 重置文本缓冲区

        emit(
          runId,
          "agent.trace",
          { text: `开始第 ${stepNumber + 1} 轮判断下一步。` },
          send,
        );
      },

      // onFinish: 流式生成完成时的回调
      // finishReason: 完成原因（"stop"=正常结束, "tool-calls"=工具调用中, "length"=达到长度限制）
      // usage: token 使用量统计
      onFinish: async ({ finishReason, usage, text }) => {
        // ========== 调试日志：完成 ==========
        logStreamEnd();
        logAgentFinish(finishReason, usage);
        logFinalOutput(text);

        // 检查是否处于等待审批状态
        const latestRun = getRun(runId);
        if (latestRun?.status === "waiting_approval") {
          emit(
            runId,
            "agent.trace",
            { text: "Agent 已暂停，正在等待用户处理审阅队列。" },
            send,
          );
          return;
        }

        if (latestRun && runHasWriteOperations(latestRun.events)) {
          const saveResults = await saveSessionDocuments(
            latestRun.documents.map((doc) => doc.id),
          );
          const changedCount = saveResults.filter((item) => item.saved).length;
          emit(
            runId,
            "agent.trace",
            {
              text: `已保存本次涉及的 ${saveResults.length} 个文档，${changedCount} 个存在变更。`,
            },
            send,
          );
        }

        // 正常完成，更新状态并发送完成事件
        setRunStatus(runId, "finished");
        emit(
          runId,
          "agent.finished",
          { finishReason, usage, summary: "Agent 任务已完成。" },
          send,
        );
      },
    });

    // 消费 textStream：逐块读取生成的文本
    // textStream 是一个异步迭代器（AsyncIterable），使用 for await...of 遍历
    // 每个 delta 是一小段文本片段，前端可以实时显示（打字机效果）
    for await (const delta of result.textStream) {
      // 检查任务是否被取消
      const latestRun = getRun(runId);
      if (latestRun?.status === "cancelled") break;

      // ========== 调试日志：实时打印流式文本 ==========
      logStreamChunk(delta);
      stepTextBuffer += delta;

      // 发送文本片段给前端
      emit(runId, "agent.message.delta", { text: delta }, send);
    }

    // consumeStream: 必须调用此方法以确保流被完全消费
    // 即使 textStream 已经遍历完毕，也需要调用此方法来释放资源
    // 如果不调用，可能会导致内存泄漏或连接未正确关闭
    await result.consumeStream();
  } catch (error) {
    // ========== 调试日志：Agent 错误 ==========
    logAgentError(error);

    // 错误处理：更新状态并发送错误事件
    setRunStatus(runId, "error");
    emit(
      runId,
      "agent.error",
      {
        message: error instanceof Error ? error.message : "Agent 运行失败",
      },
      send,
    );
  }
}
