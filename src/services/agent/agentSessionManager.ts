/**
 * ============================================================
 * 【Agent会话管理器 - agentSessionManager.ts】
 * ============================================================
 *
 * 【链路式工程流说明】
 * 这是Agent会话管理的核心模块，负责：
 * 1. 管理Agent运行实例的生命周期
 * 2. 创建、获取、取消运行实例
 * 3. 管理事件历史
 * 4. 处理审批请求和输入请求
 * 5. 管理运行状态
 *
 * 【架构位置】
 * agentWs.ts → 【agentSessionManager.ts】 → AgentRun实例
 * agentRunner.ts → 【agentSessionManager.ts】 → AgentRun实例
 *
 * 【数据流】
 * agentWs.ts调用createRun()
 *   ↓
 * 创建AgentRun实例
 *   ↓
 * 存储在runs Map中
 *   ↓
 * agentRunner.ts通过getRun()获取实例
 *   ↓
 * 执行任务并更新状态
 *
 * 【管理的数据】
 * - runs: 所有运行实例的Map
 * - approvalResolvers: 审批Promise的resolve函数
 * - inputResolvers: 输入Promise的resolve函数
 *
 * 【导出的函数】
 * - createRun: 创建运行实例
 * - getRun: 获取运行实例
 * - cancelRun: 取消运行实例
 * - setRunStatus: 设置运行状态
 * - addEvent: 添加事件
 * - addPendingApproval: 添加待处理审批
 * - addPendingInput: 添加待处理输入
 * - resolvePendingApproval: 解析待处理审批
 * - resolvePendingInput: 解析待处理输入
 * - waitForApprovalResult: 等待审批结果
 * - waitForInputResult: 等待输入结果
 * - resolveApprovalResult: 解析审批结果
 * - resolveInputResult: 解析输入结果
 *
 * 【使用的模块】
 * crypto: Node.js加密模块
 *   - randomUUID: 生成UUID
 *
 * ./agentTypes: Agent类型定义
 *   - AgentEvent: Agent事件类型
 *   - AgentEventType: Agent事件类型枚举
 *   - AgentRun: Agent运行实例类型
 *   - AgentRunStatus: Agent运行状态类型
 *   - AgentInputRequest: Agent输入请求类型
 *   - AgentInputResolution: Agent输入解析类型
 *   - AgentStartPayload: Agent启动负载类型
 *   - ApprovalItem: 审批项类型
 *   - ApprovalResolution: 审批解析类型
 *   - PendingApproval: 待处理审批类型
 * ============================================================
 */

// ... (原始文件内容)
import { randomUUID } from "crypto";
import type {
  AgentEvent,
  AgentEventType,
  AgentRun,
  AgentRunStatus,
  AgentInputRequest,
  AgentInputResolution,
  AgentStartPayload,
  ApprovalItem,
  ApprovalResolution,
  PendingApproval,
} from "./agentTypes";

const runs = new Map<string, AgentRun>();
const approvalResolvers = new Map<
  string,
  (resolution: ApprovalResolution) => void
>();
const inputResolvers = new Map<
  string,
  (resolution: AgentInputResolution) => void
>();

export function createRun(payload: AgentStartPayload): AgentRun {
  const runId = randomUUID();
  const documents = payload.documents?.length
    ? payload.documents
    : payload.docId
      ? [{ id: payload.docId, name: "当前文档", active: true }]
      : [];
  const activeDoc = documents.find((doc) => doc.active) ?? documents[0];
  const run: AgentRun = {
    runId,
    activeDocId: activeDoc?.id ?? null,
    documents,
    prompt: payload.prompt,
    permissionMode: payload.permissionMode,
    llm: payload.llm,
    toolPolicy: {
      documentToolCallCount: 0,
      hasLowTokenExploration: false,
      fullTextBlockedCount: 0,
      completedStyleVerificationCount: 0,
    },
    status: "running",
    events: [],
    pendingApprovals: [],
    pendingInputs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  runs.set(runId, run);
  return run;
}

export function getRun(runId: string): AgentRun | undefined {
  return runs.get(runId);
}

export function setRunStatus(runId: string, status: AgentRunStatus): void {
  const run = runs.get(runId);
  if (!run) return;
  run.status = status;
  run.updatedAt = Date.now();
}

export function addEvent(
  runId: string,
  type: AgentEventType,
  payload: Record<string, unknown>,
): AgentEvent {
  const event: AgentEvent = {
    type,
    runId,
    payload,
    ts: Date.now(),
  };
  const run = runs.get(runId);
  if (run) {
    run.events.push(event);
    run.updatedAt = Date.now();
  }
  return event;
}

export function addPendingApproval(
  runId: string,
  items: ApprovalItem[],
  toolCallId?: string,
): PendingApproval {
  const run = runs.get(runId);
  if (!run) {
    throw new Error(`Agent run 不存在: ${runId}`);
  }

  const approval: PendingApproval = {
    approvalId: randomUUID(),
    toolCallId,
    items,
    createdAt: Date.now(),
  };
  run.pendingApprovals.push(approval);
  approvalResolvers.set(approval.approvalId, () => {});
  run.status = "waiting_approval";
  run.updatedAt = Date.now();
  return approval;
}

export function waitForApprovalResult(
  approvalId: string,
): Promise<ApprovalResolution> {
  return new Promise((resolve) => {
    approvalResolvers.set(approvalId, resolve);
  });
}

export function addPendingInput(
  runId: string,
  request: Omit<AgentInputRequest, "inputRequestId" | "createdAt">,
): AgentInputRequest {
  const run = runs.get(runId);
  if (!run) {
    throw new Error(`Agent run 不存在: ${runId}`);
  }

  const inputRequest: AgentInputRequest = {
    ...request,
    inputRequestId: randomUUID(),
    createdAt: Date.now(),
  };
  run.pendingInputs.push(inputRequest);
  inputResolvers.set(inputRequest.inputRequestId, () => {});
  run.status = "waiting_approval";
  run.updatedAt = Date.now();
  return inputRequest;
}

export function waitForInputResult(
  inputRequestId: string,
): Promise<AgentInputResolution> {
  return new Promise((resolve) => {
    inputResolvers.set(inputRequestId, resolve);
  });
}

export function resolvePendingInput(
  runId: string,
  inputRequestId: string,
): AgentInputRequest | undefined {
  const run = runs.get(runId);
  if (!run) return undefined;

  const index = run.pendingInputs.findIndex(
    (input) => input.inputRequestId === inputRequestId,
  );
  if (index < 0) return undefined;

  const [input] = run.pendingInputs.splice(index, 1);
  run.updatedAt = Date.now();
  if (
    run.pendingApprovals.length === 0 &&
    run.pendingInputs.length === 0 &&
    run.status === "waiting_approval"
  ) {
    run.status = "running";
  }
  return input;
}

export function resolveInputResult(
  inputRequestId: string,
  resolution: AgentInputResolution,
): void {
  const resolver = inputResolvers.get(inputRequestId);
  inputResolvers.delete(inputRequestId);
  resolver?.(resolution);
}

export function resolveApprovalResult(
  approvalId: string,
  resolution: ApprovalResolution,
): void {
  const resolver = approvalResolvers.get(approvalId);
  approvalResolvers.delete(approvalId);
  resolver?.(resolution);
}

export function resolvePendingApproval(
  runId: string,
  approvalId: string,
): PendingApproval | undefined {
  const run = runs.get(runId);
  if (!run) return undefined;

  const index = run.pendingApprovals.findIndex(
    (approval) => approval.approvalId === approvalId,
  );
  if (index < 0) return undefined;

  const [approval] = run.pendingApprovals.splice(index, 1);
  run.updatedAt = Date.now();
  if (
    run.pendingApprovals.length === 0 &&
    run.pendingInputs.length === 0 &&
    run.status === "waiting_approval"
  ) {
    run.status = "running";
  }
  return approval;
}

export function cancelRun(runId: string): void {
  setRunStatus(runId, "cancelled");
}
