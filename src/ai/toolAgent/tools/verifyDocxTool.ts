import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { ToolDefinition, ToolExecutionContext } from "../toolTypes";
import { CandidateFillPlanSchema, type FillPlanAction, type FillPlanEndpoint } from "./generateFillPlanTool";

export const VerifyDocxArgsSchema = z.object({
  plan: z.unknown(),
  dryRunResult: z.unknown().optional(),
  targetDocId: z.string().optional(),
  targetInspection: z.unknown().optional(),
  requireAllMatched: z.boolean().optional().default(false),
  allowPartialMatch: z.boolean().optional().default(true),
  includeDiagnostics: z.boolean().optional().default(true),
  includeRaw: z.boolean().optional().default(false),
  maxChecks: z.number().int().positive().optional().default(200),
  maxIssues: z.number().int().positive().optional().default(200),
  maxTextLength: z.number().int().positive().optional().default(200),
});

const VerificationIssueSchema = z.object({
  severity: z.enum(["info", "warning", "error", "blocked"]),
  code: z.string(),
  message: z.string(),
  actionId: z.string().optional(),
  tableIndex: z.number().optional(),
  row: z.number().optional(),
  col: z.number().optional(),
  targetRef: z.string().optional(),
});

const VerificationCheckSchema = z.object({
  actionId: z.string(),
  actionType: z.string(),
  status: z.enum(["matched", "missing", "mismatch", "skipped", "needs_review", "blocked", "invalid"]),
  expectedTextPreview: z.string().optional(),
  actualTextPreview: z.string().optional(),
  confidence: z.number().optional(),
  target: z.object({
    tableIndex: z.number().optional(),
    row: z.number().optional(),
    col: z.number().optional(),
    ref: z.string().optional(),
    nodeId: z.string().optional(),
  }).optional(),
  reason: z.string().optional(),
  issues: z.array(z.string()).optional(),
});

export const VerifyDocxResultSchema = z.object({
  status: z.enum(["matched", "partial", "missing", "blocked", "failed"]),
  targetDocId: z.string().optional(),
  summary: z.string().optional(),
  stats: z.object({
    actionCount: z.number(),
    checkedActionCount: z.number(),
    matchedCount: z.number(),
    missingCount: z.number(),
    mismatchCount: z.number(),
    skippedCount: z.number(),
    needsReviewCount: z.number(),
    blockedCount: z.number(),
  }),
  checks: z.array(VerificationCheckSchema),
  issues: z.array(VerificationIssueSchema),
  diagnostics: z.object({
    targetTableCount: z.number().optional(),
    targetCellCount: z.number().optional(),
    inspectedTargetCellCount: z.number().optional(),
  }).optional(),
  warnings: z.array(z.string()).optional(),
  raw: z.unknown().optional(),
});

export type VerifyDocxArgs = z.infer<typeof VerifyDocxArgsSchema>;
export type VerifyDocxResult = z.infer<typeof VerifyDocxResultSchema>;
type VerificationIssue = z.infer<typeof VerificationIssueSchema>;
type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

interface TargetCellInfo {
  tableIndex?: number;
  row?: number;
  col?: number;
  ref?: string;
  nodeId?: string;
  text: string;
}

export function createVerifyDocxTool(): ToolDefinition<
  typeof VerifyDocxArgsSchema,
  typeof VerifyDocxResultSchema
> {
  return {
    name: "verify_docx",
    description:
      "Read-only diagnostic verifier that checks whether the current target DOCX state matches a candidate_only fill plan. It never writes or executes the plan.",
    permission: "diagnostic",
    argsSchema: VerifyDocxArgsSchema,
    resultSchema: VerifyDocxResultSchema,
    guard: (args, context) => {
      if (!args.plan) {
        return { allowed: false, reason: "Missing candidate fill plan." };
      }

      const planRecord = asRecord(args.plan);
      const candidatePlan = planRecord && asRecord(planRecord.plan) ? asRecord(planRecord.plan) : planRecord;
      if (candidatePlan?.mode !== "candidate_only") {
        return { allowed: false, reason: "Plan mode must be candidate_only." };
      }

      const targetDocId = resolveTargetDocId(args, context);
      if (!args.targetInspection && !targetDocId) {
        return { allowed: false, reason: "Missing targetInspection or targetDocId." };
      }
      if (!args.targetInspection && targetDocId && !fileRegistry.get(targetDocId)) {
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
        return buildResult("failed", targetDocId, emptyStats(), [], issues, args, warnings);
      }

      const plan = parsedPlan.data;
      const targetCells = args.targetInspection
        ? targetCellsFromInspection(args.targetInspection, warnings)
        : await targetCellsFromDocument(targetDocId, warnings);
      const targetIndex = buildTargetIndex(targetCells);
      const dryRunIssues = extractDryRunIssues(args.dryRunResult);
      const checks: VerificationCheck[] = [];
      const issues: VerificationIssue[] = dryRunIssues.slice(0, args.maxIssues);

      for (const action of plan.actions.slice(0, args.maxChecks)) {
        const actionIssues: VerificationIssue[] = [];
        const check = verifyAction(action, targetIndex, args, actionIssues);
        checks.push(check);
        issues.push(...actionIssues);
      }

      if (plan.actions.length > args.maxChecks) {
        warnings.push(`Checks truncated at maxChecks=${args.maxChecks}`);
      }

      const limitedIssues = issues.slice(0, args.maxIssues);
      if (limitedIssues.length < issues.length) {
        warnings.push(`Issues truncated at maxIssues=${args.maxIssues}`);
      }

      const stats = buildStats(plan.actions.length, checks);
      const status = resultStatus(stats, limitedIssues, args);

      return buildResult(status, targetDocId, stats, checks, limitedIssues, args, warnings, {
        targetTableCount: countTargetTables(targetCells),
        targetCellCount: targetCells.length,
        inspectedTargetCellCount: targetCells.length,
      }, args.includeRaw ? {
        originalIssueCount: issues.length,
        dryRunIssueCount: dryRunIssues.length,
        targetCellCount: targetCells.length,
      } : undefined);
    },
  };
}

function parseCandidatePlan(input: unknown): ReturnType<typeof CandidateFillPlanSchema.safeParse> {
  const record = asRecord(input);
  const plan = record && asRecord(record.plan) ? record.plan : input;
  return CandidateFillPlanSchema.safeParse(plan);
}

function resolveTargetDocId(args: VerifyDocxArgs, context: ToolExecutionContext): string | undefined {
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
        text: stringValue(item?.textPreview) || stringValue(item?.text) || "",
      });
    }
  }

  if (cells.length === 0) warnings.push("No target cells found in provided targetInspection.");
  return cells;
}

function buildTargetIndex(cells: TargetCellInfo[]): Map<string, TargetCellInfo> {
  const index = new Map<string, TargetCellInfo>();
  for (const cell of cells) {
    index.set(targetKey(cell), cell);
    if (cell.ref) index.set(`ref:${cell.ref}`, cell);
  }
  return index;
}

function verifyAction(
  action: FillPlanAction,
  targetIndex: Map<string, TargetCellInfo>,
  args: VerifyDocxArgs,
  issues: VerificationIssue[]
): VerificationCheck {
  const expectedText = getExpectedText(action);
  const targetCell = action.target ? findTargetCell(action.target, targetIndex) : undefined;

  if (!action.actionId) {
    issues.push(createIssue("blocked", "MISSING_ACTION_ID", "Action is missing actionId.", action));
  }
  if (!Number.isFinite(action.confidence) || action.confidence < 0 || action.confidence > 1) {
    issues.push(createIssue("blocked", "INVALID_CONFIDENCE", "Action confidence must be a number between 0 and 1.", action));
  }

  if (action.type === "skip") {
    return createCheck(action, "skipped", expectedText, undefined, "skip action is not verified against target text");
  }
  if (action.type === "needs_review") {
    issues.push(createIssue("warning", "NEEDS_REVIEW_ACTION", "Action requires review before verification can be trusted.", action));
    return createCheck(action, "needs_review", expectedText, targetCell?.text, "action requires review", issuesForAction(issues, action));
  }
  if (action.type !== "fill_cell" && action.type !== "copy_text") {
    issues.push(createIssue("blocked", "UNSUPPORTED_ACTION_TYPE", `Unsupported action type: ${action.type}`, action));
    return createCheck(action, "invalid", expectedText, targetCell?.text, "unsupported action type", issuesForAction(issues, action));
  }
  if (!action.target) {
    issues.push(createIssue("blocked", "MISSING_TARGET", `${action.type} action requires target.`, action));
    return createCheck(action, "blocked", expectedText, undefined, "missing target", issuesForAction(issues, action));
  }
  if (!targetCell) {
    issues.push(createIssue("blocked", "TARGET_NOT_FOUND", "Target cell was not found in target structure.", action));
    return createCheck(action, "missing", expectedText, undefined, "target cell not found", issuesForAction(issues, action));
  }
  if (!expectedText.trim()) {
    issues.push(createIssue("warning", "MISSING_EXPECTED_TEXT", "Action is missing valuePreview and source.textPreview.", action));
    return createCheck(action, "mismatch", expectedText, targetCell.text, "missing expected text", issuesForAction(issues, action));
  }

  const actualText = normalizeText(targetCell.text);
  const expected = normalizeText(expectedText);
  if (!actualText) {
    return createCheck(action, "missing", expectedText, targetCell.text, "target text is empty");
  }
  if (actualText === expected || actualText.includes(expected)) {
    return createCheck(action, "matched", expectedText, targetCell.text, "expected text found in target");
  }

  issues.push(createIssue("warning", "TEXT_MISMATCH", "Target text is non-empty but does not match expected text.", action));
  return createCheck(action, "mismatch", expectedText, targetCell.text, "target text does not match expected text", issuesForAction(issues, action));
}

function findTargetCell(target: FillPlanEndpoint, index: Map<string, TargetCellInfo>): TargetCellInfo | undefined {
  return index.get(targetKey(target)) || (target.ref ? index.get(`ref:${target.ref}`) : undefined);
}

function createCheck(
  action: FillPlanAction,
  status: VerificationCheck["status"],
  expectedText: string,
  actualText: string | undefined,
  reason: string,
  issues?: string[]
): VerificationCheck {
  return {
    actionId: action.actionId,
    actionType: action.type,
    status,
    expectedTextPreview: truncateText(expectedText, 200),
    actualTextPreview: actualText !== undefined ? truncateText(actualText, 200) : undefined,
    confidence: action.confidence,
    target: action.target ? {
      tableIndex: action.target.tableIndex,
      row: action.target.row,
      col: action.target.col,
      ref: action.target.ref,
      nodeId: action.target.nodeId,
    } : undefined,
    reason,
    issues,
  };
}

function getExpectedText(action: FillPlanAction): string {
  return action.valuePreview || action.source?.textPreview || "";
}

function extractDryRunIssues(input: unknown): VerificationIssue[] {
  const record = asRecord(input);
  const issues = Array.isArray(record?.issues) ? record.issues : [];
  return issues.flatMap(issue => {
    const item = asRecord(issue);
    if (!item) return [];
    const severity = stringValue(item.severity);
    if (severity !== "info" && severity !== "warning" && severity !== "error" && severity !== "blocked") return [];
    return [{
      severity,
      code: stringValue(item.code) || "DRY_RUN_ISSUE",
      message: stringValue(item.message) || "Issue reported by dry-run.",
      actionId: stringValue(item.actionId),
      tableIndex: numberValue(item.tableIndex),
      row: numberValue(item.row),
      col: numberValue(item.col),
      targetRef: stringValue(item.targetRef),
    }];
  });
}

function buildStats(actionCount: number, checks: VerificationCheck[]): VerifyDocxResult["stats"] {
  return {
    actionCount,
    checkedActionCount: checks.length,
    matchedCount: checks.filter(check => check.status === "matched").length,
    missingCount: checks.filter(check => check.status === "missing").length,
    mismatchCount: checks.filter(check => check.status === "mismatch").length,
    skippedCount: checks.filter(check => check.status === "skipped").length,
    needsReviewCount: checks.filter(check => check.status === "needs_review").length,
    blockedCount: checks.filter(check => check.status === "blocked" || check.status === "invalid").length,
  };
}

function resultStatus(
  stats: VerifyDocxResult["stats"],
  issues: VerificationIssue[],
  args: VerifyDocxArgs
): VerifyDocxResult["status"] {
  if (issues.some(issue => issue.severity === "blocked")) return "blocked";
  if (issues.some(issue => issue.severity === "error")) return "failed";
  if (args.requireAllMatched && (stats.missingCount > 0 || stats.mismatchCount > 0 || stats.needsReviewCount > 0)) {
    return "blocked";
  }
  if (stats.checkedActionCount === 0) return "missing";
  if (stats.matchedCount === stats.checkedActionCount - stats.skippedCount && stats.matchedCount > 0) return "matched";
  if (stats.matchedCount > 0 && args.allowPartialMatch) return "partial";
  if (stats.matchedCount > 0 && !args.allowPartialMatch) return "blocked";
  return "missing";
}

function buildResult(
  status: VerifyDocxResult["status"],
  targetDocId: string | undefined,
  stats: VerifyDocxResult["stats"],
  checks: VerificationCheck[],
  issues: VerificationIssue[],
  args: VerifyDocxArgs,
  warnings: string[],
  diagnostics?: VerifyDocxResult["diagnostics"],
  raw?: unknown
): VerifyDocxResult {
  return {
    status,
    targetDocId,
    summary: `verify_docx ${status}: checked=${stats.checkedActionCount}, matched=${stats.matchedCount}, missing=${stats.missingCount}, mismatch=${stats.mismatchCount}`,
    stats,
    checks,
    issues,
    diagnostics: args.includeDiagnostics ? diagnostics : undefined,
    warnings,
    raw: args.includeRaw ? raw : undefined,
  };
}

function emptyStats(): VerifyDocxResult["stats"] {
  return {
    actionCount: 0,
    checkedActionCount: 0,
    matchedCount: 0,
    missingCount: 0,
    mismatchCount: 0,
    skippedCount: 0,
    needsReviewCount: 0,
    blockedCount: 0,
  };
}

function createIssue(
  severity: VerificationIssue["severity"],
  code: string,
  message: string,
  action?: FillPlanAction
): VerificationIssue {
  return {
    severity,
    code,
    message,
    actionId: action?.actionId,
    tableIndex: action?.target?.tableIndex,
    row: action?.target?.row,
    col: action?.target?.col,
    targetRef: action?.target?.ref,
  };
}

function issuesForAction(issues: VerificationIssue[], action: FillPlanAction): string[] {
  return issues.filter(issue => issue.actionId === action.actionId).map(issue => issue.code);
}

function targetKey(target: FillPlanEndpoint | TargetCellInfo): string {
  return `${target.tableIndex ?? ""}:${target.row ?? ""}:${target.col ?? ""}:${target.ref || ""}`;
}

function countTargetTables(cells: TargetCellInfo[]): number {
  return new Set(cells.map(cell => cell.tableIndex).filter(value => value !== undefined)).size;
}

function normalizeText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const text = normalizeText(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
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
