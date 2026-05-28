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
  const documents =
    payload.documents?.length
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
