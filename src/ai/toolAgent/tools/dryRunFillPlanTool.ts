import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { RawCell } from "../../workflow/nodes/docAnalyst/types";
import type { ToolDefinition, ToolExecutionContext } from "../toolTypes";
import { CandidateFillPlanSchema, type CandidateFillPlan, type FillPlanAction, type FillPlanEndpoint } from "./generateFillPlanTool";

export const DryRunFillPlanArgsSchema = z.object({
  plan: z.unknown(),
  targetDocId: z.string().optional(),
  targetInspection: z.unknown().optional(),
  requireHighConfidence: z.boolean().optional().default(false),
  minConfidence: z.number().min(0).max(1).optional().default(0.75),
  allowNeedsReview: z.boolean().optional().default(false),
  allowSkipActions: z.boolean().optional().default(true),
  includeDiagnostics: z.boolean().optional().default(true),
  includeRaw: z.boolean().optional().default(false),
  maxIssues: z.number().int().positive().optional().default(200),
});

const DryRunIssueSchema = z.object({
  severity: z.enum(["info", "warning", "error", "blocked"]),
  code: z.string(),
  message: z.string(),
  actionId: z.string().optional(),
  targetRef: z.string().optional(),
  tableIndex: z.number().optional(),
  row: z.number().optional(),
  col: z.number().optional(),
});

const CheckedActionSchema = z.object({
  actionId: z.string(),
  type: z.string(),
  status: z.enum(["ok", "warning", "blocked", "invalid"]),
  confidence: z.number().optional(),
  targetExists: z.boolean().optional(),
  targetHasText: z.boolean().optional(),
  issues: z.array(z.string()).optional(),
});

export const DryRunFillPlanResultSchema = z.object({
  status: z.enum(["pass", "warning", "blocked", "failed"]),
  targetDocId: z.string().optional(),
  summary: z.string().optional(),
  stats: z.object({
    actionCount: z.number(),
    fillCellActionCount: z.number(),
    copyTextActionCount: z.number(),
    needsReviewActionCount: z.number(),
    skipActionCount: z.number(),
    highConfidenceActionCount: z.number(),
    lowConfidenceActionCount: z.number(),
    duplicateTargetCount: z.number(),
    missingTargetCount: z.number(),
    missingValueCount: z.number(),
    invalidActionCount: z.number(),
  }),
  issues: z.array(DryRunIssueSchema),
  checkedActions: z.array(CheckedActionSchema),
  diagnostics: z.object({
    targetTableCount: z.number().optional(),
    targetCellCount: z.number().optional(),
    inspectedTargetCellCount: z.number().optional(),
  }).optional(),
  warnings: z.array(z.string()).optional(),
  raw: z.unknown().optional(),
});

export type DryRunFillPlanArgs = z.infer<typeof DryRunFillPlanArgsSchema>;
export type DryRunFillPlanResult = z.infer<typeof DryRunFillPlanResultSchema>;
type DryRunIssue = z.infer<typeof DryRunIssueSchema>;
type CheckedAction = z.infer<typeof CheckedActionSchema>;

interface TargetCellInfo {
  tableIndex?: number;
  row?: number;
  col?: number;
  ref?: string;
  nodeId?: string;
  text: string;
}

export function createDryRunFillPlanTool(): ToolDefinition<
  typeof DryRunFillPlanArgsSchema,
  typeof DryRunFillPlanResultSchema
> {
  return {
    name: "dry_run_fill_plan",
    description:
      "Diagnostic tool that validates a candidate_only fill plan against target document structure without executing or writing anything.",
    permission: "diagnostic",
    argsSchema: DryRunFillPlanArgsSchema,
    resultSchema: DryRunFillPlanResultSchema,
    guard: (args, context) => {
      if (!args.plan) {
        return { allowed: false, reason: "Missing candidate fill plan." };
      }

      const planRecord = asRecord(args.plan);
      const rootRecord = planRecord && asRecord(planRecord.plan) ? planRecord : undefined;
      const plan = rootRecord ? asRecord(rootRecord.plan) : planRecord;
      if (plan?.mode !== "candidate_only") {
        return { allowed: false, reason: "Plan mode must be candidate_only." };
      }

      const targetDocId = resolveTargetDocId(args, context);
      if (!args.targetInspection && !targetDocId) {
        return { allowed: false, reason: "Missing targetInspection or targetDocId." };
      }
      if (targetDocId && !fileRegistry.get(targetDocId)) {
        return { allowed: false, reason: `Target document not found in registry: ${targetDocId}` };
      }

      return { allowed: true };
    },
    execute: async (args, context) => {
      const targetDocId = resolveTargetDocId(args, context);
      const warnings: string[] = [];
      const parsedPlan = parseCandidatePlan(args.plan);

      if (!parsedPlan.success) {
        const issues = parsedPlan.error.issues.slice(0, args.maxIssues).map(issue => createIssue(
          "blocked",
          "INVALID_PLAN",
          `Invalid candidate plan: ${issue.path.join(".") || "root"} ${issue.message}`,
        ));
        return buildResult("failed", targetDocId, emptyStats(), issues, [], args, warnings);
      }

      const plan = parsedPlan.data;
      const targetCells = args.targetInspection
        ? targetCellsFromInspection(args.targetInspection, warnings)
        : await targetCellsFromDocument(targetDocId, warnings);
      const targetIndex = buildTargetIndex(targetCells);
      const issues: DryRunIssue[] = [];
      const checkedActions: CheckedAction[] = [];
      const targetUsage = new Map<string, FillPlanAction[]>();

      for (const action of plan.actions) {
        const actionIssues: DryRunIssue[] = [];
        const targetCell = action.target ? findTargetCell(action.target, targetIndex) : undefined;

        validateActionShape(action, args, actionIssues);
        validateTarget(action, targetCell, actionIssues);
        validateConfidence(action, args, actionIssues);
        validateValue(action, actionIssues);

        if (action.target) {
          const key = targetKey(action.target);
          const group = targetUsage.get(key) || [];
          group.push(action);
          targetUsage.set(key, group);
        }

        issues.push(...actionIssues);
        checkedActions.push({
          actionId: action.actionId,
          type: action.type,
          status: statusForIssues(actionIssues),
          confidence: action.confidence,
          targetExists: action.target ? Boolean(targetCell) : undefined,
          targetHasText: targetCell ? targetCell.text.trim() !== "" : undefined,
          issues: actionIssues.map(issue => issue.code),
        });
      }

      addDuplicateTargetIssues(targetUsage, issues);
      addPlanConflictIssues(plan, issues);

      const limitedIssues = issues.slice(0, args.maxIssues);
      if (limitedIssues.length < issues.length) {
        warnings.push(`Issues truncated at maxIssues=${args.maxIssues}`);
      }

      const stats = buildStats(plan.actions, limitedIssues);
      const status = resultStatus(limitedIssues);

      return buildResult(status, targetDocId, stats, limitedIssues, checkedActions, args, warnings, {
        targetTableCount: countTargetTables(targetCells),
        targetCellCount: targetCells.length,
        inspectedTargetCellCount: targetCells.length,
      }, args.includeRaw ? {
        targetCellCount: targetCells.length,
        originalIssueCount: issues.length,
      } : undefined);
    },
  };
}

function parseCandidatePlan(input: unknown): ReturnType<typeof CandidateFillPlanSchema.safeParse> {
  const record = asRecord(input);
  const plan = record && asRecord(record.plan) ? record.plan : input;
  return CandidateFillPlanSchema.safeParse(plan);
}

function resolveTargetDocId(args: DryRunFillPlanArgs, context: ToolExecutionContext): string | undefined {
  const record = asRecord(args.plan);
  return args.targetDocId || stringValue(record?.targetDocId) || context.targetDocId || context.docId;
}

async function targetCellsFromDocument(targetDocId: string | undefined, warnings: string[]): Promise<TargetCellInfo[]> {
  if (!targetDocId) return [];
  const payload = await parseDocument(targetDocId, true);
  return payload.tables.flatMap(table => table.cells.map(cell => ({
    tableIndex: cell.tableIndex,
    row: cell.row,
    col: cell.col,
    ref: cell.ref,
    nodeId: cell.nodeId,
    text: cell.text,
  })));
}

function targetCellsFromInspection(input: unknown, warnings: string[]): TargetCellInfo[] {
  const record = asRecord(input);
  const tables = Array.isArray(record?.tables) ? record.tables : [];
  const cells: TargetCellInfo[] = [];

  for (const table of tables) {
    const tableRecord = asRecord(table);
    const tableIndex = numberValue(tableRecord?.index);
    const tableCells = Array.isArray(tableRecord?.cells) ? tableRecord.cells : [];
    for (const cell of tableCells) {
      const item = asRecord(cell);
      cells.push({
        tableIndex: numberValue(item?.tableIndex) ?? tableIndex,
        row: numberValue(item?.row),
        col: numberValue(item?.col),
        ref: stringValue(item?.ref),
        nodeId: stringValue(item?.nodeId),
        text: stringValue(item?.textPreview) || "",
      });
    }
  }

  if (cells.length === 0) warnings.push("No target cells found in provided targetInspection.");
  return cells;
}

function buildTargetIndex(cells: TargetCellInfo[]): Map<string, TargetCellInfo> {
  const index = new Map<string, TargetCellInfo>();
  for (const cell of cells) {
    const structuredKey = targetKey(cell);
    index.set(structuredKey, cell);
    if (cell.ref) index.set(`ref:${cell.ref}`, cell);
  }
  return index;
}

function findTargetCell(target: FillPlanEndpoint, index: Map<string, TargetCellInfo>): TargetCellInfo | undefined {
  return index.get(targetKey(target)) || (target.ref ? index.get(`ref:${target.ref}`) : undefined);
}

function validateActionShape(action: FillPlanAction, args: DryRunFillPlanArgs, issues: DryRunIssue[]): void {
  if (!action.actionId) issues.push(createIssue("blocked", "MISSING_ACTION_ID", "Action is missing actionId."));
  if (!Number.isFinite(action.confidence) || action.confidence < 0 || action.confidence > 1) {
    issues.push(createIssue("blocked", "INVALID_CONFIDENCE", "Action confidence must be a number between 0 and 1.", action));
  }
  if (action.type === "fill_cell" && !action.target) {
    issues.push(createIssue("blocked", "MISSING_TARGET", "fill_cell action requires target.", action));
  }
  if (action.type === "copy_text" && (!action.source || !action.target)) {
    issues.push(createIssue("blocked", "MISSING_SOURCE_OR_TARGET", "copy_text action requires source and target.", action));
  }
  if (action.type === "needs_review") {
    issues.push(createIssue(args.allowNeedsReview ? "warning" : "blocked", "NEEDS_REVIEW_ACTION", "Action requires review.", action));
  }
  if (action.type === "skip" && !args.allowSkipActions) {
    issues.push(createIssue("blocked", "SKIP_ACTION_NOT_ALLOWED", "skip action is not allowed by dry-run options.", action));
  }
}

function validateTarget(action: FillPlanAction, targetCell: TargetCellInfo | undefined, issues: DryRunIssue[]): void {
  if (!action.target || action.type === "skip" || action.type === "needs_review") return;
  if (action.target.tableIndex === undefined || action.target.row === undefined || action.target.col === undefined) {
    issues.push(createIssue("error", "INCOMPLETE_TARGET_COORDINATES", "Target should include tableIndex, row, and col.", action));
  }
  if (!targetCell) {
    issues.push(createIssue("blocked", "TARGET_NOT_FOUND", "Target cell was not found in target structure.", action));
    return;
  }
  if (targetCell.text.trim() !== "") {
    issues.push(createIssue("warning", "TARGET_HAS_TEXT", "Target cell already has text.", action));
  }
}

function validateConfidence(action: FillPlanAction, args: DryRunFillPlanArgs, issues: DryRunIssue[]): void {
  if (action.confidence >= args.minConfidence) return;
  issues.push(createIssue(args.requireHighConfidence ? "blocked" : "warning", "LOW_CONFIDENCE", `Action confidence is below minConfidence=${args.minConfidence}.`, action));
}

function validateValue(action: FillPlanAction, issues: DryRunIssue[]): void {
  if (action.type !== "fill_cell" && action.type !== "copy_text") return;
  const value = action.valuePreview || action.source?.textPreview || "";
  if (!value.trim()) {
    issues.push(createIssue("blocked", "MISSING_VALUE", "Action is missing valuePreview and source.textPreview.", action));
  }
}

function addDuplicateTargetIssues(targetUsage: Map<string, FillPlanAction[]>, issues: DryRunIssue[]): void {
  for (const [key, actions] of targetUsage) {
    if (actions.length <= 1) continue;
    const severity = actions.every(action => action.type === "fill_cell") ? "blocked" : "warning";
    const values = new Set(actions.map(action => action.valuePreview || action.source?.textPreview || ""));
    issues.push(createIssue(
      severity,
      "DUPLICATE_TARGET",
      `Multiple actions target the same cell: ${key}${values.size > 1 ? " with different values" : ""}.`,
      actions[0]
    ));
  }
}

function addPlanConflictIssues(plan: CandidateFillPlan, issues: DryRunIssue[]): void {
  for (const conflict of plan.conflicts || []) {
    issues.push({
      severity: conflict.actionIds && conflict.actionIds.length > 1 ? "blocked" : "warning",
      code: "PLAN_CONFLICT",
      message: conflict.reason,
      actionId: conflict.actionIds?.[0],
    });
  }
}

function buildStats(actions: FillPlanAction[], issues: DryRunIssue[]): DryRunFillPlanResult["stats"] {
  const duplicateTargetCount = issues.filter(issue => issue.code === "DUPLICATE_TARGET").length;
  return {
    actionCount: actions.length,
    fillCellActionCount: actions.filter(action => action.type === "fill_cell").length,
    copyTextActionCount: actions.filter(action => action.type === "copy_text").length,
    needsReviewActionCount: actions.filter(action => action.type === "needs_review").length,
    skipActionCount: actions.filter(action => action.type === "skip").length,
    highConfidenceActionCount: actions.filter(action => action.confidence >= 0.75).length,
    lowConfidenceActionCount: issues.filter(issue => issue.code === "LOW_CONFIDENCE").length,
    duplicateTargetCount,
    missingTargetCount: issues.filter(issue => issue.code === "MISSING_TARGET" || issue.code === "TARGET_NOT_FOUND").length,
    missingValueCount: issues.filter(issue => issue.code === "MISSING_VALUE").length,
    invalidActionCount: issues.filter(issue => issue.severity === "blocked" || issue.severity === "error").length,
  };
}

function buildResult(
  status: DryRunFillPlanResult["status"],
  targetDocId: string | undefined,
  stats: DryRunFillPlanResult["stats"],
  issues: DryRunIssue[],
  checkedActions: CheckedAction[],
  args: DryRunFillPlanArgs,
  warnings: string[],
  diagnostics?: DryRunFillPlanResult["diagnostics"],
  raw?: unknown
): DryRunFillPlanResult {
  return {
    status,
    targetDocId,
    summary: `dry-run ${status}: actions=${stats.actionCount}, issues=${issues.length}`,
    stats,
    issues,
    checkedActions,
    diagnostics: args.includeDiagnostics ? diagnostics : undefined,
    warnings,
    raw: args.includeRaw ? raw : undefined,
  };
}

function emptyStats(): DryRunFillPlanResult["stats"] {
  return {
    actionCount: 0,
    fillCellActionCount: 0,
    copyTextActionCount: 0,
    needsReviewActionCount: 0,
    skipActionCount: 0,
    highConfidenceActionCount: 0,
    lowConfidenceActionCount: 0,
    duplicateTargetCount: 0,
    missingTargetCount: 0,
    missingValueCount: 0,
    invalidActionCount: 0,
  };
}

function resultStatus(issues: DryRunIssue[]): DryRunFillPlanResult["status"] {
  if (issues.some(issue => issue.severity === "blocked")) return "blocked";
  if (issues.some(issue => issue.severity === "error")) return "failed";
  if (issues.some(issue => issue.severity === "warning")) return "warning";
  return "pass";
}

function statusForIssues(issues: DryRunIssue[]): CheckedAction["status"] {
  if (issues.some(issue => issue.severity === "blocked")) return "blocked";
  if (issues.some(issue => issue.severity === "error")) return "invalid";
  if (issues.some(issue => issue.severity === "warning")) return "warning";
  return "ok";
}

function createIssue(
  severity: DryRunIssue["severity"],
  code: string,
  message: string,
  action?: FillPlanAction
): DryRunIssue {
  return {
    severity,
    code,
    message,
    actionId: action?.actionId,
    targetRef: action?.target?.ref,
    tableIndex: action?.target?.tableIndex,
    row: action?.target?.row,
    col: action?.target?.col,
  };
}

function targetKey(target: FillPlanEndpoint | TargetCellInfo): string {
  return `${target.tableIndex ?? ""}:${target.row ?? ""}:${target.col ?? ""}:${target.ref || ""}`;
}

function countTargetTables(cells: TargetCellInfo[]): number {
  return new Set(cells.map(cell => cell.tableIndex).filter(value => value !== undefined)).size;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
