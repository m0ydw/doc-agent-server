import { z } from "zod";

export const ToolNameSchema = z.enum([
  "inspect_documents",
  "inspect_table_structure",
  "inspect_sdk_cell_text",
  "extract_reference_templates",
  "generate_fill_plan",
  "dry_run_fill_plan",
  "write_docx",
  "verify_docx",
  "ask_user",
  "finish",
]);

export const ToolDecisionSchema = z.object({
  summary: z.string(),
  observations: z.array(z.string()),
  reason: z.string(),
  toolName: ToolNameSchema,
  args: z.record(z.string(), z.unknown()),
});

export const FinishResultSchema = z.object({
  status: z.enum(["success", "blocked", "failed", "needs_user_input"]),
  summary: z.string(),
  details: z.unknown().optional(),
});

export const ToolErrorSchema = z.object({
  toolName: z.string(),
  message: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

export type ToolName = z.infer<typeof ToolNameSchema>;
export type ToolDecision = z.infer<typeof ToolDecisionSchema>;
export type FinishResult = z.infer<typeof FinishResultSchema>;
export type ToolError = z.infer<typeof ToolErrorSchema>;
