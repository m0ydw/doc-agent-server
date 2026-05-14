import type { ToolHistoryEntry } from "./toolTypes";

export interface DocxToolAgentState {
  userInput: string;
  docId?: string;
  referenceDocId?: string;
  targetDocId?: string;

  documents?: unknown;
  tableInspection?: unknown;
  sdkTextInspection?: unknown;
  templateExtraction?: unknown;
  executionPlan?: unknown;
  dryRun?: unknown;
  writeResult?: unknown;
  verification?: unknown;

  toolHistory: ToolHistoryEntry[];
  workflowError?: string;
  needsUserInput?: boolean;

  stepCount: number;
  maxSteps: number;
}

export interface CreateInitialDocxToolAgentStateInput {
  userInput: string;
  docId?: string;
  referenceDocId?: string;
  targetDocId?: string;
  maxSteps?: number;
}

export function createInitialDocxToolAgentState(
  input: CreateInitialDocxToolAgentStateInput
): DocxToolAgentState {
  return {
    userInput: input.userInput,
    docId: input.docId,
    referenceDocId: input.referenceDocId,
    targetDocId: input.targetDocId,
    toolHistory: [],
    stepCount: 0,
    maxSteps: input.maxSteps ?? 12,
  };
}
