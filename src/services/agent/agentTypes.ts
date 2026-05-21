export type PermissionMode =
  | "read_only"
  | "review_required"
  | "auto_tracked"
  | "auto_apply";

export type DeepSeekConfig = {
  provider: "deepseek";
  apiKey: string;
  baseURL: string;
  model: string;
};

export type AgentDocumentRef = {
  id: string;
  name: string;
  active?: boolean;
};

export type AgentStartPayload = {
  docId?: string;
  documents?: AgentDocumentRef[];
  prompt: string;
  permissionMode: PermissionMode;
  llm: DeepSeekConfig;
};

export type AgentEventType =
  | "agent.started"
  | "agent.trace"
  | "agent.message.delta"
  | "tool.started"
  | "tool.finished"
  | "approval.requested"
  | "approval.resolved"
  | "agent.finished"
  | "agent.error";

export type AgentEvent = {
  type: AgentEventType;
  runId: string;
  payload: Record<string, unknown>;
  ts: number;
};

export type AgentCellWrite = {
  operation?: "cell_write" | "text_replace";
  documentName?: string;
  ref: string;
  text: string;
  reason?: string;
  tableIndex?: number;
  row?: number;
  col?: number;
};

export type ApprovalItem = AgentCellWrite & {
  itemId: string;
  oldText: string;
  newText: string;
};

export type PendingApproval = {
  approvalId: string;
  toolCallId?: string;
  items: ApprovalItem[];
  createdAt: number;
};

export type ApprovalResolution = {
  approvalId: string;
  approvedCount: number;
  rejectedCount: number;
  approved: ApprovalItem[];
  rejected: ApprovalItem[];
  writeResult: unknown[];
  verifyResult: unknown[];
  replaceResult: unknown[];
};

export type AgentRunStatus =
  | "running"
  | "waiting_approval"
  | "finished"
  | "error"
  | "cancelled";

export type AgentRun = {
  runId: string;
  activeDocId: string;
  documents: AgentDocumentRef[];
  prompt: string;
  permissionMode: PermissionMode;
  llm: DeepSeekConfig;
  status: AgentRunStatus;
  events: AgentEvent[];
  pendingApprovals: PendingApproval[];
  createdAt: number;
  updatedAt: number;
};
