import { randomUUID } from "crypto";
import type {
  AgentEvent,
  AgentEventType,
  AgentRun,
  AgentRunStatus,
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

export function createRun(payload: AgentStartPayload): AgentRun {
  const runId = randomUUID();
  const documents =
    payload.documents?.length
      ? payload.documents
      : payload.docId
        ? [{ id: payload.docId, name: "当前文档", active: true }]
        : [];
  const activeDoc = documents.find((doc) => doc.active) ?? documents[0];
  if (!activeDoc) {
    throw new Error("Agent 至少需要一个可操作文档");
  }

  const run: AgentRun = {
    runId,
    activeDocId: activeDoc.id,
    documents,
    prompt: payload.prompt,
    permissionMode: payload.permissionMode,
    llm: payload.llm,
    status: "running",
    events: [],
    pendingApprovals: [],
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
  if (run.pendingApprovals.length === 0 && run.status === "waiting_approval") {
    run.status = "running";
  }
  return approval;
}

export function cancelRun(runId: string): void {
  setRunStatus(runId, "cancelled");
}
