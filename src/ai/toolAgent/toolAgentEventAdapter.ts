import type { FinishResult } from "./schemas";
import type { ToolAgentEvent } from "./events";

export interface ToolAgentWsMessage {
  type: string;
  data?: Record<string, unknown>;
}

export function mapToolAgentEventToWsMessages(event: ToolAgentEvent): ToolAgentWsMessage[] {
  switch (event.type) {
    case "tool_agent_start":
      return [
        { type: "phase_start", data: { phase: "tool_agent" } },
        { type: "phase_status", data: { text: `Tool Agent started with maxSteps=${event.maxSteps}` } },
      ];

    case "tool_agent_decision":
      return [{
        type: "phase_status",
        data: { text: `Tool Agent selected ${event.decision.toolName}: ${event.decision.summary}` },
      }];

    case "tool_start":
      return [{
        type: "tool_start",
        data: {
          tool: event.toolName,
          args: summarizeForUi(event.args),
        },
      }];

    case "tool_result":
      return [{
        type: "tool_result",
        data: {
          success: true,
          tool: event.toolName,
          result: summarizeForUi(event.result),
        },
      }];

    case "tool_error":
      return [{
        type: "error",
        data: {
          message: `${event.error.toolName}: ${event.error.message}`,
        },
      }];

    case "tool_agent_blocked":
      return [
        {
          type: "warning",
          data: { message: event.reason },
        },
        {
          type: "summary",
          data: {
            result: "intervention",
            summary_text: event.reason,
            detail: event.warnings?.join("\n") || "",
            failed_tasks: [],
          },
        },
      ];

    case "tool_agent_finish":
      return [{
        type: "summary",
        data: finishToSummaryData(event.result),
      }];
  }
}

function finishToSummaryData(result: FinishResult): Record<string, unknown> {
  return {
    result: result.status === "success" ? "success" : result.status === "needs_user_input" ? "intervention" : "failed",
    summary_text: result.summary,
    detail: summarizeForUi(result.details),
    failed_tasks: result.status === "success" ? [] : ["tool_agent"],
  };
}

function summarizeForUi(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const record = asRecord(value);
  if (record) {
    const compact = {
      status: record.status,
      summary: record.summary,
      tableCount: record.tableCount,
      actionCount: asRecord(record.stats)?.actionCount,
      appliedActionCount: record.appliedActionCount,
      generatedActionCount: asRecord(record.diagnostics)?.generatedActionCount,
      targetDocId: record.targetDocId,
      referenceDocId: record.referenceDocId,
    };
    const useful = Object.fromEntries(Object.entries(compact).filter(([, item]) => item !== undefined));
    if (Object.keys(useful).length > 0) return truncate(JSON.stringify(useful));
  }

  try {
    return truncate(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
}

function truncate(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
