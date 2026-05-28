export type PermissionMode =
  | "read_only"
  | "review_required"
  | "auto_tracked"
  | "auto_apply";

export type LlmProvider = "deepseek" | "xiaomimimo";

export type LlmConfig = {
  provider: LlmProvider;
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
  llm: LlmConfig;
};

export type AgentEventType =
  | "agent.started"
  | "agent.trace"
  | "agent.message.delta"
  | "tool.started"
  | "tool.finished"
  | "approval.requested"
  | "approval.resolved"
  | "agent.input.requested"
  | "agent.input.resolved"
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
  saveResult?: unknown[];
};

export type AgentInputRequest = {
  inputRequestId: string;
  toolCallId?: string;
  question: string;
  reason?: string;
  expectedAnswerType?: "text" | "choice" | "yes_no";
  choices?: string[];
  createdAt: number;
};

export type AgentInputResolution = {
  inputRequestId: string;
  answer: string;
};

export type AgentRunStatus =
  | "running"
  | "waiting_approval"
  | "finished"
  | "error"
  | "cancelled";

export type AgentRun = {
  runId: string;
  activeDocId: string | null;
  documents: AgentDocumentRef[];
  prompt: string;
  permissionMode: PermissionMode;
  llm: LlmConfig;
  toolPolicy: AgentToolPolicyState;
  status: AgentRunStatus;
  events: AgentEvent[];
  pendingApprovals: PendingApproval[];
  pendingInputs: AgentInputRequest[];
  createdAt: number;
  updatedAt: number;
};

export type FullTextReadPurpose =
  | "explicit_full_document_request"
  | "targeted_tools_insufficient"
  | "final_integrity_check";

export type PendingStyleVerification = {
  documentName?: string;
  query: Record<string, unknown>;
  sourceTool: "apply_text_style";
  createdAt: number;
};

export type AgentToolPolicyState = {
  documentToolCallCount: number;
  hasLowTokenExploration: boolean;
  fullTextBlockedCount: number;
  lastFullTextBlockedReason?: string;
  pendingStyleVerification?: PendingStyleVerification;
  completedStyleVerificationCount: number;
};
