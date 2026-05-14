import type { FinishResult, ToolDecision, ToolError } from "./schemas";

export interface BaseToolAgentEvent {
  type: string;
  step: number;
  timestamp: string;
}

export interface ToolAgentStartEvent extends BaseToolAgentEvent {
  type: "tool_agent_start";
  userInput: string;
  docId?: string;
  referenceDocId?: string;
  targetDocId?: string;
  maxSteps: number;
}

export interface ToolAgentDecisionEvent extends BaseToolAgentEvent {
  type: "tool_agent_decision";
  decision: ToolDecision;
}

export interface ToolStartEvent extends BaseToolAgentEvent {
  type: "tool_start";
  toolName: string;
  args: unknown;
}

export interface ToolResultEvent extends BaseToolAgentEvent {
  type: "tool_result";
  toolName: string;
  result: unknown;
}

export interface ToolErrorEvent extends BaseToolAgentEvent {
  type: "tool_error";
  error: ToolError;
}

export interface ToolAgentFinishEvent extends BaseToolAgentEvent {
  type: "tool_agent_finish";
  result: FinishResult;
}

export interface ToolAgentBlockedEvent extends BaseToolAgentEvent {
  type: "tool_agent_blocked";
  reason: string;
  warnings?: string[];
}

export type ToolAgentEvent =
  | ToolAgentStartEvent
  | ToolAgentDecisionEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ToolAgentFinishEvent
  | ToolAgentBlockedEvent;

export function nowIso(): string {
  return new Date().toISOString();
}
