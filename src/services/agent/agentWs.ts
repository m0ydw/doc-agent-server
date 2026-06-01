/**
 * ============================================================
 * 【Agent WebSocket服务 - agentWs.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是Agent WebSocket服务的核心模块，负责：
 * 1. 管理与前端的WebSocket连接
 * 2. 处理前端发送的任务指令
 * 3. 转发Agent执行进度给前端
 * 4. 处理审批请求和用户输入请求
 * 5. 支持事件重新播放（页面刷新后恢复状态）
 * 
 * 【架构位置】
 * 前端AgentPanel → WebSocket → 【agentWs.ts】 → agentRunner → AI模型
 * 
 * 【数据流】
 * 前端发送agent.start消息
 *   ↓
 * agentWs.ts解析消息
 *   ↓
 * 创建Agent运行实例
 *   ↓
 * 调用agentRunner执行任务
 *   ↓
 * 通过回调函数发送进度事件
 *   ↓
 * 前端接收事件并更新UI
 * 
 * 【WebSocket通信协议】
 * 前端 → 后端：
 * - agent.start: 启动Agent任务
 * - agent.cancel: 取消正在运行的任务
 * - agent.approval.resolve: 处理审批请求
 * - agent.input.resolve: 处理输入请求
 * - agent.replay: 重新播放事件（用于页面刷新后恢复状态）
 * 
 * 后端 → 前端：
 * - agent.started: Agent已启动
 * - agent.trace: 思考过程
 * - tool.started/tool.finished: 工具调用
 * - agent.message.delta: 流式文本片段
 * - approval.requested: 需要审批
 * - approval.resolved: 审批已处理
 * - agent.input.requested: 需要用户输入
 * - agent.input.resolved: 输入已处理
 * - agent.finished/agent.error: 任务结束
 * 
 * 【使用的库】
 * ws: WebSocket库
 *   - WebSocketServer: WebSocket服务器类
 *   - WebSocket: WebSocket连接类型
 * 
 * http: Node.js HTTP模块
 *   - Server: HTTP服务器类型
 * 
 * ./editor: 编辑操作模块
 *   - replaceByRefs: 根据引用替换
 *   - writeCellsText: 写入单元格文本
 *   - verifyCells: 验证单元格
 * 
 * ./session: 会话管理模块
 *   - saveSessionDocuments: 保存会话文档
 * 
 * ./agentSessionManager: Agent会话管理器
 *   - addEvent: 添加事件
 *   - cancelRun: 取消运行
 *   - createRun: 创建运行
 *   - getRun: 获取运行
 *   - resolveApprovalResult: 解析审批结果
 *   - resolveInputResult: 解析输入结果
 *   - resolvePendingInput: 解析待处理输入
 *   - resolvePendingApproval: 解析待处理审批
 * 
 * ./agentRunner: Agent运行器
 *   - runAgent: 运行Agent
 * 
 * ./agentTypes: Agent类型定义
 *   - AgentEvent: Agent事件类型
 *   - AgentStartPayload: Agent启动负载类型
 *   - ApprovalResolution: 审批解析类型
 *   - LlmProvider: LLM提供商类型
 *   - PermissionMode: 权限模式类型
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【WebSocket库】
import { WebSocketServer, type WebSocket } from "ws";

// 【HTTP模块】
import type { Server } from "http";

// 【编辑操作模块】
import * as editor from "../editor";

// 【会话管理模块】
import * as sessionManager from "../session";

// 【Agent会话管理器】
import {
  addEvent,
  cancelRun,
  createRun,
  getRun,
  resolveApprovalResult,
  resolveInputResult,
  resolvePendingInput,
  resolvePendingApproval,
} from "./agentSessionManager";

// 【Agent运行器】
import { runAgent } from "./agentRunner";

// 【类型定义】
import type {
  AgentEvent,
  AgentStartPayload,
  ApprovalResolution,
  LlmProvider,
  PermissionMode,
} from "./agentTypes";

// ================================================================
// 【类型定义】
// ================================================================

/**
 * 【客户端消息类型】
 * 
 * 【功能说明】
 * 定义前端可以发送的所有消息类型
 * 
 * 【消息类型】
 * - agent.start: 启动Agent任务
 * - agent.cancel: 取消正在运行的任务
 * - agent.approval.resolve: 处理审批请求
 * - agent.input.resolve: 处理输入请求
 * - agent.replay: 重新播放事件
 */
type ClientMessage =
  | { type: "agent.start"; payload: AgentStartPayload }
  | { type: "agent.cancel"; runId: string }
  | {
      type: "agent.approval.resolve";
      runId: string;
      payload: {
        approvalId: string;
        decisions: Array<{
          itemId: string;
          approved: boolean;
          reason?: string;
        }>;
      };
    }
  | {
      type: "agent.input.resolve";
      runId: string;
      payload: {
        inputRequestId: string;
        answer: string;
      };
    }
  | { type: "agent.replay"; runId: string };

// ================================================================
// 【辅助函数】
// ================================================================

/**
 * 【发送消息】
 * 
 * 【功能说明】
 * 通过WebSocket发送消息给前端
 * 检查连接状态，避免发送失败
 * 
 * @param ws - WebSocket连接
 * @param event - Agent事件
 */
function send(ws: WebSocket, event: AgentEvent): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

/**
 * 【发送原始消息】
 * 
 * 【功能说明】
 * 构造并发送原始消息
 * 
 * @param ws - WebSocket连接
 * @param type - 事件类型
 * @param runId - 运行ID
 * @param payload - 事件负载
 */
function sendRaw(
  ws: WebSocket,
  type: AgentEvent["type"],
  runId: string,
  payload: Record<string, unknown>,
): void {
  send(ws, { type, runId, payload, ts: Date.now() });
}

// ================================================================
// 【配置常量】
// ================================================================

/**
 * 【允许的权限模式】
 * 
 * 【功能说明】
 * 定义所有允许的权限模式
 */
const allowedPermissionModes = new Set<PermissionMode>([
  "read_only",
  "review_required",
  "auto_tracked",
  "auto_apply",
]);

/**
 * 【LLM提供商默认配置】
 * 
 * 【功能说明】
 * 定义每个LLM提供商的默认API地址和模型
 */
const providerDefaults: Record<
  LlmProvider,
  { baseURL: string; model: string }
> = {
  deepseek: {
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  },
  xiaomimimo: {
    baseURL: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-pro",
  },
};

// ================================================================
// 【规范化函数】
// ================================================================

/**
 * 【规范化LLM提供商】
 * 
 * 【功能说明】
 * 将未知类型的值规范化为LlmProvider
 * 如果不是"xiaomimimo"，默认返回"deepseek"
 * 
 * @param provider - 原始值
 * @returns 规范化后的LlmProvider
 */
function normalizeLlmProvider(provider: unknown): LlmProvider {
  return provider === "xiaomimimo" ? "xiaomimimo" : "deepseek";
}

/**
 * 【规范化权限模式】
 * 
 * 【功能说明】
 * 将未知类型的值规范化为PermissionMode
 * 如果不在允许列表中，默认返回"review_required"
 * 
 * @param mode - 原始值
 * @returns 规范化后的PermissionMode
 */
function normalizePermissionMode(mode: unknown): PermissionMode {
  return allowedPermissionModes.has(mode as PermissionMode)
    ? (mode as PermissionMode)
    : "review_required";
}

/**
 * 【规范化启动负载】
 * 
 * 【功能说明】
 * 规范化前端发送的启动负载
 * 包括文档列表、权限模式、LLM配置等
 * 
 * @param payload - 原始负载
 * @returns 规范化后的负载
 */
function normalizeStartPayload(payload: AgentStartPayload): AgentStartPayload {
  const provider = normalizeLlmProvider(payload.llm?.provider);
  const defaults = providerDefaults[provider];
  
  // 【规范化文档列表】
  const documents =
    payload.documents?.length
      ? payload.documents
      : payload.docId
        ? [{ id: payload.docId, name: "当前文档", active: true }]
        : [];
  
  return {
    ...payload,
    documents,
    permissionMode: normalizePermissionMode(payload.permissionMode),
    llm: {
      provider,
      apiKey: payload.llm?.apiKey || "",
      baseURL: payload.llm?.baseURL || defaults.baseURL,
      model: payload.llm?.model || defaults.model,
    },
  };
}

// ================================================================
// 【消息处理函数】
// ================================================================

/**
 * 【处理审批解析】
 * 
 * 【功能说明】
 * 处理前端发送的审批决策
 * 
 * 【执行流程】
 * 1. 获取Agent运行实例
 * 2. 获取待处理的审批请求
 * 3. 分离批准和拒绝的项
 * 4. 执行批准的写入操作
 * 5. 保存文档
 * 6. 发送审批结果事件
 * 7. 解析审批结果
 * 
 * @param ws - WebSocket连接
 * @param message - 审批解析消息
 */
async function handleApprovalResolve(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "agent.approval.resolve" }>,
): Promise<void> {
  // 【获取Agent运行实例】
  const run = getRun(message.runId);
  if (!run) {
    sendRaw(ws, "agent.error", message.runId, { message: "Agent run 不存在" });
    return;
  }

  // 【获取待处理的审批请求】
  const approval = resolvePendingApproval(
    message.runId,
    message.payload.approvalId,
  );
  if (!approval) {
    sendRaw(ws, "agent.error", message.runId, { message: "审批项不存在或已处理" });
    return;
  }

  // 【分离批准和拒绝的项】
  const decisions = new Map(
    message.payload.decisions.map((decision) => [decision.itemId, decision]),
  );
  const approved = approval.items.filter(
    (item) => decisions.get(item.itemId)?.approved,
  );
  const rejected = approval.items.filter(
    (item) => !decisions.get(item.itemId)?.approved,
  );

  // 【执行批准的写入操作】
  const writeResult = [];
  const verifyResult = [];
  const replaceResult = [];
  const changedDocIds = new Set<string>();

  for (const item of approved) {
    // 【查找目标文档】
    const targetDoc =
      run.documents.find((doc) => doc.name === item.documentName) ??
      run.documents.find((doc) => doc.id === run.activeDocId) ??
      run.documents[0];
    if (!targetDoc) continue;

    if (item.operation === "text_replace") {
      // 【文本替换操作】
      replaceResult.push(
        ...(await editor.replaceByRefs(targetDoc.id, [
          {
            ref: item.ref,
            oldText: item.oldText,
            text: item.newText,
            reason: item.reason,
          },
        ])),
      );
      changedDocIds.add(targetDoc.id);
    } else {
      // 【单元格写入操作】
      const cell = {
        ref: item.ref,
        text: item.newText,
        reason: item.reason,
      };
      writeResult.push(...(await editor.writeCellsText(targetDoc.id, [cell])));
      verifyResult.push(...(await editor.verifyCells(targetDoc.id, [cell])));
      changedDocIds.add(targetDoc.id);
    }
  }
  
  // 【保存文档】
  const saveResult = await sessionManager.saveSessionDocuments(
    Array.from(changedDocIds),
  );

  // 【构造审批解析结果】
  const resolution: ApprovalResolution = {
    approvalId: approval.approvalId,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    approved,
    rejected,
    writeResult,
    verifyResult,
    replaceResult,
    saveResult,
  };
  
  // 【发送审批结果事件】
  const event = addEvent(message.runId, "approval.resolved", resolution);
  send(ws, event);
  
  // 【解析审批结果】
  resolveApprovalResult(approval.approvalId, resolution);
}

/**
 * 【处理输入解析】
 * 
 * 【功能说明】
 * 处理前端发送的用户输入
 * 
 * 【执行流程】
 * 1. 获取Agent运行实例
 * 2. 获取待处理的输入请求
 * 3. 构造输入解析结果
 * 4. 发送输入结果事件
 * 5. 解析输入结果
 * 
 * @param ws - WebSocket连接
 * @param message - 输入解析消息
 */
function handleInputResolve(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "agent.input.resolve" }>,
): void {
  // 【获取Agent运行实例】
  const run = getRun(message.runId);
  if (!run) {
    sendRaw(ws, "agent.error", message.runId, { message: "Agent run 不存在" });
    return;
  }

  // 【获取待处理的输入请求】
  const input = resolvePendingInput(
    message.runId,
    message.payload.inputRequestId,
  );
  if (!input) {
    sendRaw(ws, "agent.error", message.runId, {
      message: "Agent 输入请求不存在或已处理",
    });
    return;
  }

  // 【构造输入解析结果】
  const resolution = {
    inputRequestId: input.inputRequestId,
    answer: message.payload.answer,
  };
  
  // 【发送输入结果事件】
  const event = addEvent(message.runId, "agent.input.resolved", resolution);
  send(ws, event);
  
  // 【解析输入结果】
  resolveInputResult(input.inputRequestId, resolution);
}

// ================================================================
// 【主函数】
// ================================================================

/**
 * 【挂载Agent WebSocket服务】
 * 
 * 【功能说明】
 * 将WebSocket服务器挂载到HTTP服务器上
 * 处理前端的WebSocket连接和消息
 * 
 * 【执行流程】
 * 1. 创建WebSocket服务器
 * 2. 监听连接事件
 * 3. 处理消息事件
 * 4. 根据消息类型分发处理
 * 
 * @param server - HTTP服务器
 * @returns WebSocket服务器实例
 */
export function attachAgentWebSocket(server: Server): WebSocketServer {
  // 【创建WebSocket服务器】
  const wss = new WebSocketServer({ server, path: "/ws/agent" });

  // 【监听连接事件】
  wss.on("connection", (ws) => {
    // 【监听消息事件】
    ws.on("message", (raw) => {
      void (async () => {
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          sendRaw(ws, "agent.error", "unknown", { message: "无法解析 WS 消息" });
          return;
        }

        // 【处理agent.start消息】
        if (message.type === "agent.start") {
          const payload = normalizeStartPayload(message.payload);
          
          // 【创建Agent运行实例】
          const run = createRun(payload);
          
          // 【发送agent.started事件】
          send(
            ws,
            addEvent(run.runId, "agent.started", {
              runId: run.runId,
              documentCount: run.documents.length,
              activeDocument:
                run.documents.find((doc) => doc.id === run.activeDocId)?.name ??
                "当前文档",
              permissionMode: run.permissionMode,
              model: run.llm.model,
            }),
          );
          
          // 【运行Agent】
          void runAgent(run.runId, (event) => send(ws, event));
          return;
        }

        // 【处理agent.cancel消息】
        if (message.type === "agent.cancel") {
          cancelRun(message.runId);
          send(
            ws,
            addEvent(message.runId, "agent.finished", {
              summary: "Agent 任务已取消。",
            }),
          );
          return;
        }

        // 【处理agent.replay消息】
        if (message.type === "agent.replay") {
          const run = getRun(message.runId);
          if (!run) return;
          // 【重新播放所有事件】
          run.events.forEach((event) => send(ws, event));
          return;
        }

        // 【处理agent.approval.resolve消息】
        if (message.type === "agent.approval.resolve") {
          await handleApprovalResolve(ws, message);
          return;
        }

        // 【处理agent.input.resolve消息】
        if (message.type === "agent.input.resolve") {
          handleInputResolve(ws, message);
          return;
        }
      })();
    });
  });

  return wss;
}
