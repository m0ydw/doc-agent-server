import type { DocxToolAgentState } from "./state";
import type { ToolDefinition, ToolHistoryEntry } from "./toolTypes";

export interface ToolDecisionPromptInput {
  state: DocxToolAgentState;
  availableTools: ToolDefinition[];
  policy?: "planning_only";
  feedback?: string[];
}

interface StateSummary {
  userInput: string;
  docId?: string;
  referenceDocId?: string;
  targetDocId?: string;
  stepCount: number;
  maxSteps: number;
  documents?: unknown;
  tableInspection?: unknown;
  sdkTextInspection?: unknown;
  templateExtraction?: unknown;
  executionPlan?: unknown;
  dryRun?: unknown;
  verification?: unknown;
  workflowError?: string;
  needsUserInput?: boolean;
}

export function summarizeStateForModel(state: DocxToolAgentState): StateSummary {
  return {
    userInput: truncateString(state.userInput, 1200),
    docId: state.docId,
    referenceDocId: state.referenceDocId,
    targetDocId: state.targetDocId,
    stepCount: state.stepCount,
    maxSteps: state.maxSteps,
    documents: summarizeUnknown(state.documents),
    tableInspection: summarizeUnknown(state.tableInspection),
    sdkTextInspection: summarizeUnknown(state.sdkTextInspection),
    templateExtraction: summarizeUnknown(state.templateExtraction),
    executionPlan: summarizeUnknown(state.executionPlan),
    dryRun: summarizeUnknown(state.dryRun),
    verification: summarizeUnknown(state.verification),
    workflowError: state.workflowError,
    needsUserInput: state.needsUserInput,
  };
}

export function summarizeToolHistoryForModel(
  toolHistory: ToolHistoryEntry[],
  maxEntries = 5
): unknown[] {
  return toolHistory.slice(-maxEntries).map(entry => ({
    step: entry.step,
    toolName: entry.toolName,
    args: summarizeUnknown(entry.args),
    result: summarizeUnknown(entry.result),
    error: summarizeUnknown(entry.error),
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  }));
}

export function summarizeAvailableToolsForModel(tools: ToolDefinition[]): unknown[] {
  return tools
    .filter(tool => tool.name !== "write_docx")
    .map(tool => ({
      name: tool.name,
      permission: tool.permission,
      description: truncateString(tool.description, 260),
    }));
}

export function buildToolDecisionPrompt(input: ToolDecisionPromptInput): string {
  const availableTools = summarizeAvailableToolsForModel(input.availableTools);
  const controlTools = [
    { name: "ask_user", permission: "control", description: "Ask the user for missing information." },
    { name: "finish", permission: "control", description: "Finish the planning-only workflow." },
  ];
  const stateSummary = summarizeStateForModel(input.state);
  const historySummary = summarizeToolHistoryForModel(input.state.toolHistory);
  const feedback = input.feedback?.length ? input.feedback : undefined;

  return [
    "SYSTEM:",
    "You are the decision provider for a DOCX Tool Agent. Return exactly one strict JSON object.",
    "Do not output Markdown, prose, code fences, comments, or multiple JSON objects.",
    "Choose only a toolName from availableTools or the control tools ask_user/finish.",
    "Never choose write_docx. Never write documents. Never infer table/row/col from nodeId or ref strings.",
    "Do not invent docId, referenceDocId, or targetDocId. If required IDs are missing, choose ask_user.",
    "Do not finish with success before dry_run_fill_plan has run for an execution plan.",
    "",
    "DEVELOPER:",
    "Goal: plan a safe DOCX table-fill workflow from a reference document to a target document.",
    "Recommended order: inspect_documents, inspect_table_structure or inspect_sdk_cell_text, extract_reference_templates, generate_fill_plan, dry_run_fill_plan, verify_docx, finish.",
    "The first implementation is planning_only. Safe tools may inspect, diagnose, plan, dry-run, and verify. They must not write.",
    "If a dry run is blocked or failed, choose ask_user or finish with blocked/failed status.",
    "If verification reports missing values before writing, explain that the document appears not yet applied.",
    "",
    "AVAILABLE_TOOLS:",
    stringifyForPrompt([...availableTools, ...controlTools]),
    "",
    "CURRENT_STATE_SUMMARY:",
    stringifyForPrompt(stateSummary),
    "",
    "RECENT_TOOL_HISTORY_SUMMARY:",
    stringifyForPrompt(historySummary),
    "",
    feedback ? "VALIDATION_FEEDBACK:" : "",
    feedback ? stringifyForPrompt(feedback) : "",
    "",
    "OUTPUT_SCHEMA:",
    stringifyForPrompt({
      summary: "short decision summary",
      observations: ["facts from current state"],
      reason: "why this tool is next",
      toolName: "one available tool name",
      args: {},
    }),
  ].filter(Boolean).join("\n");
}

function summarizeUnknown(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, 400);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 5).map(item => summarizeUnknown(item)),
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    const preferredKeys = [
      "status",
      "summary",
      "docId",
      "referenceDocId",
      "targetDocId",
      "tableCount",
      "cellCount",
      "nonEmptyCellCount",
      "textCoverage",
      "templates",
      "fieldCandidates",
      "actions",
      "plan",
      "diagnostics",
      "stats",
      "issues",
      "checks",
      "warnings",
      "error",
      "message",
    ];

    for (const key of preferredKeys) {
      if (key in record && key !== "raw" && key !== "cells" && key !== "documents") {
        summary[key] = summarizeFocusedValue(record[key], key);
      }
    }

    if (Object.keys(summary).length === 0) {
      for (const key of Object.keys(record).slice(0, 12)) {
        if (key === "raw" || key === "cells" || key === "documents") {
          summary[key] = summarizeOmittedValue(record[key]);
        } else {
          summary[key] = summarizeFocusedValue(record[key], key);
        }
      }
    }

    return summary;
  }
  return String(value);
}

function summarizeFocusedValue(value: unknown, key: string): unknown {
  if (key === "actions" && Array.isArray(value)) {
    return { count: value.length };
  }
  if (key === "templates" && Array.isArray(value)) {
    return { count: value.length };
  }
  if (key === "fieldCandidates" && Array.isArray(value)) {
    return { count: value.length };
  }
  if (key === "issues" && Array.isArray(value)) {
    return { count: value.length, sample: value.slice(0, 5).map(item => summarizeUnknown(item)) };
  }
  if (key === "checks" && Array.isArray(value)) {
    return { count: value.length, sample: value.slice(0, 5).map(item => summarizeUnknown(item)) };
  }
  if (key === "warnings" && Array.isArray(value)) {
    return value.slice(0, 10).map(item => summarizeUnknown(item));
  }
  if (key === "plan" && value && typeof value === "object") {
    const plan = value as Record<string, unknown>;
    return {
      version: plan.version,
      mode: plan.mode,
      actionCount: Array.isArray(plan.actions) ? plan.actions.length : undefined,
      unresolvedFieldCount: Array.isArray(plan.unresolvedFields) ? plan.unresolvedFields.length : undefined,
      conflictCount: Array.isArray(plan.conflicts) ? plan.conflicts.length : undefined,
    };
  }
  return summarizeUnknown(value);
}

function summarizeOmittedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { omitted: true, type: "array", length: value.length };
  }
  if (value && typeof value === "object") {
    return { omitted: true, type: "object", keys: Object.keys(value as Record<string, unknown>).slice(0, 12) };
  }
  return { omitted: true };
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function stringifyForPrompt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
