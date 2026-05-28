import type {
  AgentEvent,
  AgentRun,
  FullTextReadPurpose,
  PendingStyleVerification,
} from "./agentTypes";

type FullTextReadArgs = {
  purpose?: FullTextReadPurpose;
  reason?: string;
};

type PolicyDecision = {
  allowed: boolean;
  summary?: string;
  detail?: Record<string, unknown>;
};

const lowTokenDocumentTools = new Set([
  "find_text",
  "inspect_document_tables",
  "inspect_table_structure",
  "read_table_cell",
  "read_table_style",
  "inspect_text_blocks",
  "read_text_block",
  "find_text_targets",
  "read_text_style",
  "dry_run_write_cells",
  "verify_cells",
]);

const documentTools = new Set([
  ...lowTokenDocumentTools,
  "get_text",
  "replace_text",
  "apply_table_format",
  "apply_text_style",
  "insert_text_at_block_offset",
  "write_cells_text",
]);

const explicitFullTextIntentPattern =
  /(全文|通读|整篇|全文本|全篇|完整内容|整体(审阅|审查|检查|总结|概括|分析)|总结.*文档|概括.*文档|full document|entire document|whole document|read all)/i;

function hasExplicitFullTextIntent(prompt: string): boolean {
  return explicitFullTextIntentPattern.test(prompt);
}

function hasUsefulReason(reason: string | undefined): boolean {
  return Boolean(reason && reason.trim().length >= 8);
}

function eventToolName(event: AgentEvent): string {
  return String(event.payload.name ?? "");
}

function hasLowTokenToolEvent(run: AgentRun): boolean {
  return run.events.some(
    (event) =>
      event.type === "tool.finished" &&
      event.payload.status === "ok" &&
      lowTokenDocumentTools.has(eventToolName(event)),
  );
}

function documentToolEventCount(run: AgentRun): number {
  return run.events.filter((event) => {
    if (event.type !== "tool.finished") return false;
    const name = eventToolName(event);
    return documentTools.has(name) || name.startsWith("superdoc_");
  }).length;
}

export function shouldAllowFullTextRead(
  run: AgentRun,
  args: FullTextReadArgs,
): PolicyDecision {
  const explicitIntent = hasExplicitFullTextIntent(run.prompt);
  const purpose = args.purpose;
  const reason = args.reason?.trim();
  const hasLowTokenContext =
    run.toolPolicy.hasLowTokenExploration || hasLowTokenToolEvent(run);
  const isFirstDocumentTool =
    run.toolPolicy.documentToolCallCount === 0 &&
    documentToolEventCount(run) === 0;

  if (!purpose || !hasUsefulReason(reason)) {
    return {
      allowed: false,
      summary:
        "get_text 被策略拦截：读取全文必须提供 purpose 和充分 reason，说明为什么低 token 定位工具不够。",
      detail: {
        purpose,
        reason,
        preferFirst: [
          "find_text",
          "inspect_text_blocks",
          "read_text_block",
          "inspect_document_tables",
        ],
      },
    };
  }

  if (purpose === "explicit_full_document_request" && explicitIntent) {
    return { allowed: true };
  }

  if (purpose === "final_integrity_check" && !isFirstDocumentTool) {
    return { allowed: true };
  }

  if (purpose === "targeted_tools_insufficient") {
    if (hasLowTokenContext) {
      return { allowed: true };
    }
    return {
      allowed: false,
      summary:
        "get_text 被策略拦截：purpose=targeted_tools_insufficient 前必须先尝试低 token 定位工具。",
      detail: {
        purpose,
        reason,
        preferFirst: [
          "find_text",
          "inspect_text_blocks",
          "read_text_block",
          "inspect_document_tables",
        ],
      },
    };
  }

  if (isFirstDocumentTool && !explicitIntent) {
    return {
      allowed: false,
      summary:
        "get_text 被策略拦截：本轮第一个文档工具不能读取全文，除非用户明确要求全文、通读、整体总结或整体审阅。",
      detail: {
        purpose,
        reason,
        preferFirst: [
          "find_text",
          "inspect_text_blocks",
          "read_text_block",
          "inspect_document_tables",
        ],
      },
    };
  }

  return {
    allowed: false,
    summary:
      "get_text 被策略拦截：当前任务未体现明确全文需求，请先使用低 token 定位工具。",
    detail: {
      purpose,
      reason,
      explicitIntent,
      hasLowTokenExploration: hasLowTokenContext,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function buildStyleVerification(input: unknown): PendingStyleVerification {
  const source = isRecord(input) ? input : {};
  const styleSource = isRecord(source.styleInput) ? source.styleInput : source;
  const documentName =
    typeof source.documentName === "string" ? source.documentName : undefined;
  const {
    inline: _inline,
    paragraph: _paragraph,
    paragraphStyleId: _paragraphStyleId,
    styleScope: _styleScope,
    permissionMode: _permissionMode,
    ...query
  } = styleSource;
  return {
    documentName,
    query,
    sourceTool: "apply_text_style",
    createdAt: Date.now(),
  };
}

export function requiresStyleVerification(event: AgentEvent): boolean {
  return (
    event.type === "tool.finished" &&
    event.payload.name === "apply_text_style" &&
    event.payload.status === "ok"
  );
}

export function getPendingStyleVerification(
  run: AgentRun,
): PendingStyleVerification | undefined {
  if (run.toolPolicy.pendingStyleVerification) {
    return run.toolPolicy.pendingStyleVerification;
  }

  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (event.type !== "tool.finished") continue;
    if (event.payload.name === "read_text_style" && event.payload.status === "ok") {
      return undefined;
    }
    if (event.payload.name === "apply_text_style" && event.payload.status === "ok") {
      return buildStyleVerification(event.payload.input);
    }
  }

  return undefined;
}

export function recordToolFinished(
  run: AgentRun,
  name: string,
  input: unknown,
  status: string,
): void {
  if (documentTools.has(name) || name.startsWith("superdoc_")) {
    run.toolPolicy.documentToolCallCount += 1;
  }

  if (status === "ok" && lowTokenDocumentTools.has(name)) {
    run.toolPolicy.hasLowTokenExploration = true;
  }

  if (name === "get_text" && status === "blocked") {
    run.toolPolicy.fullTextBlockedCount += 1;
    run.toolPolicy.lastFullTextBlockedReason =
      "get_text was blocked before sufficient targeted context was gathered.";
  }

  if (name === "apply_text_style" && status === "ok") {
    run.toolPolicy.pendingStyleVerification = buildStyleVerification(input);
  }

  if (name === "read_text_style" && status === "ok") {
    run.toolPolicy.pendingStyleVerification = undefined;
    run.toolPolicy.completedStyleVerificationCount += 1;
    run.toolPolicy.hasLowTokenExploration = true;
  }
}

export function buildToolUsageGuidance(run: AgentRun): string {
  const pending = run.toolPolicy.pendingStyleVerification;
  return [
    "Tool policy:",
    "- Prefer low-token targeted tools first: find_text, inspect_text_blocks, read_text_block, inspect_document_tables, inspect_table_structure.",
    "- Do not call get_text as the first document tool unless the user explicitly asks to read/summarize/review the full document.",
    "- get_text requires purpose and reason. Use purpose=targeted_tools_insufficient only after targeted tools were tried.",
    "- After apply_text_style succeeds, call read_text_style on the returned verificationQuery before finalAnswer.",
    pending
      ? `- Pending style verification exists. Call read_text_style with: ${JSON.stringify(pending.query)}`
      : "- No pending style verification at run start.",
  ].join("\n");
}
