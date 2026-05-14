import type { z } from "zod";

export type ToolPermission = "read" | "diagnostic" | "write" | "control";

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  warnings?: string[];
}

export interface ToolExecutionContext {
  requestId?: string;
  userInput: string;
  docId?: string;
  referenceDocId?: string;
  targetDocId?: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<
  TArgsSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TResultSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  permission: ToolPermission;
  argsSchema: TArgsSchema;
  resultSchema: TResultSchema;
  guard?: (
    args: z.infer<TArgsSchema>,
    context: ToolExecutionContext
  ) => GuardResult | Promise<GuardResult>;
  execute: (
    args: z.infer<TArgsSchema>,
    context: ToolExecutionContext
  ) => Promise<unknown>;
}

export interface ToolHistoryEntry {
  step: number;
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: unknown;
  startedAt: string;
  finishedAt?: string;
}
