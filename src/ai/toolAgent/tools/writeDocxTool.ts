import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { RawCell } from "../../workflow/nodes/docAnalyst/types";
import type { ToolDefinition, ToolExecutionContext } from "../toolTypes";
import { CandidateFillPlanSchema, type CandidateFillPlan, type FillPlanAction, type FillPlanEndpoint } from "./generateFillPlanTool";
import { writeCellTextByRef } from "./docxWriteAdapter";

export const WriteDocxApprovalSchema = z.object({
  confirmed: z.boolean(),
  approvedActionIds: z.array(z.string()),
  approvedAt: z.string().optional(),
  approvedBy: z.string().optional(),
});

export const WriteDocxOptionsSchema = z.object({
  allowLowConfidence: z.boolean().optional().default(false),
  allowNeedsReview: z.boolean().optional().default(false),
  maxActions: z.number().int().positive().max(200).optional().default(50),
  stopOnFirstError: z.boolean().optional().default(true),
  verifyAfterWrite: z.boolean().optional().default(false),
}).optional().default({
  allowLowConfidence: false,
  allowNeedsReview: false,
  maxActions: 50,
  stopOnFirstError: true,
  verifyAfterWrite: false,
});

export const WriteDocxArgsSchema = z.object({
  plan: z.unknown(),
  dryRunResult: z.unknown(),
  targetDocId: z.string().optional(),
  approval: WriteDocxApprovalSchema,
  options: WriteDocxOptionsSchema,
});

const WriteResultItemSchema = z.object({
  actionId: z.string(),
  status: z.enum(["applied", "skipped", "failed", "blocked"]),
  target: z.object({
    tableIndex: z.number().optional(),
    row: z.number().optional(),
    col: z.number().optional(),
    ref: z.string().optional(),
    nodeId: z.string().optional(),
  }).optional(),
  valuePreview: z.string().optional(),
  beforeTextPreview: z.string().optional(),
  afterTextPreview: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

export const WriteDocxResultSchema = z.object({
  status: z.enum(["success", "partial", "blocked", "failed"]),
  targetDocId: z.string(),
  attemptedActionCount: z.number(),
  appliedActionCount: z.number(),
  skippedActionCount: z.number(),
  failedActionCount: z.number(),
  blockedActionCount: z.number(),
  results: z.array(WriteResultItemSchema),
  warnings: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  verificationSuggestion: z.string().optional(),
});

export type WriteDocxApproval = z.infer<typeof WriteDocxApprovalSchema>;
export type WriteDocxOptions = z.infer<typeof WriteDocxOptionsSchema>;
export type WriteDocxArgs = z.infer<typeof WriteDocxArgsSchema>;
export type WriteDocxResult = z.infer<typeof WriteDocxResultSchema>;
type WriteResultItem = z.infer<typeof WriteResultItemSchema>;

interface CurrentCell {
  tableIndex: number;
  row: number;
  col: number;
  ref?: string;
  nodeId?: string;
  text: string;
}

interface DryRunGate {
  status?: string;
  blockedActionIds: Set<string>;
  invalidActionIds: Set<string>;
  blockedDuplicateTarget: boolean;
}

interface WriteDocxToolDependencies {
  fileExists?: (docId: string) => boolean;
  parseTargetDocument?: (docId: string) => Promise<{ tables: Array<{ cells: RawCell[] }> }>;
  writeCellText?: (docId: string, ref: string, text: string) => Promise<unknown>;
}

export function createWriteDocxTool(dependencies: WriteDocxToolDependencies = {}): ToolDefinition<
  typeof WriteDocxArgsSchema,
  typeof WriteDocxResultSchema
> {
  const fileExists = dependencies.fileExists || ((docId: string) => Boolean(fileRegistry.get(docId)));
  const parseTargetDocument = dependencies.parseTargetDocument || ((docId: string) => parseDocument(docId, true));
  const writeCellText = dependencies.writeCellText || writeCellTextByRef;

  return {
    name: "write_docx",
    description:
      "Write permission tool that safely writes approved candidate_only actions into a target DOCX through the existing SuperDoc setText adapter after approval and dry-run gates pass.",
    permission: "write",
    argsSchema: WriteDocxArgsSchema,
    resultSchema: WriteDocxResultSchema,
    guard: (args, context) => {
      const parsedPlan = parseCandidatePlan(args.plan);
      if (!parsedPlan.success) {
        return { allowed: false, reason: `Invalid candidate plan: ${parsedPlan.error.message}` };
      }

      const plan = parsedPlan.data;
      const targetDocId = resolveTargetDocId(args, context);
      const referenceDocId = resolveReferenceDocId(args);
      const dryRunGate = inspectDryRun(args.dryRunResult);
      const options = args.options;

      if (permissionName() !== "write") {
        return { allowed: false, reason: "write_docx permission must be write." };
      }
      if (!args.approval.confirmed) {
        return { allowed: false, reason: "Explicit approval is required." };
      }
      if (args.approval.approvedActionIds.length === 0) {
        return { allowed: false, reason: "approvedActionIds must be a non-empty array." };
      }
      if (!args.dryRunResult) {
        return { allowed: false, reason: "dryRunResult is required before write_docx." };
      }
      if (dryRunGate.status === "failed" || dryRunGate.status === "blocked") {
        return { allowed: false, reason: `dryRunResult status blocks writing: ${dryRunGate.status}` };
      }
      if (!targetDocId) {
        return { allowed: false, reason: "targetDocId is required." };
      }
      if (!fileExists(targetDocId)) {
        return { allowed: false, reason: `Target document not found in registry: ${targetDocId}` };
      }
      if (referenceDocId && referenceDocId === targetDocId) {
        return { allowed: false, reason: "referenceDocId and targetDocId must be different." };
      }
      if (plan.actions.length > options.maxActions) {
        return { allowed: false, reason: `Plan action count exceeds maxActions=${options.maxActions}.` };
      }
      if (dryRunGate.blockedDuplicateTarget) {
        return { allowed: false, reason: "dryRunResult contains blocked duplicate target issue." };
      }

      const actionMap = new Map(plan.actions.map(action => [action.actionId, action]));
      for (const actionId of args.approval.approvedActionIds) {
        const action = actionMap.get(actionId);
        if (!action) {
          return { allowed: false, reason: `Approved action not found in plan: ${actionId}` };
        }
        const actionBlockReason = validateApprovedActionForWrite(action, options, dryRunGate);
        if (actionBlockReason) {
          return { allowed: false, reason: actionBlockReason };
        }
      }

      return { allowed: true };
    },
    execute: async (args, context) => {
      const parsedPlan = parseCandidatePlan(args.plan);
      if (!parsedPlan.success) {
        return blockedResult(resolveTargetDocId(args, context) || "", `Invalid candidate plan: ${parsedPlan.error.message}`);
      }

      const plan = parsedPlan.data;
      const targetDocId = resolveTargetDocId(args, context);
      if (!targetDocId) {
        return blockedResult("", "targetDocId is required.");
      }

      const dryRunGate = inspectDryRun(args.dryRunResult);
      const approvedIds = new Set(args.approval.approvedActionIds);
      const options = args.options;
      const results: WriteResultItem[] = [];
      const warnings: string[] = [];
      const errors: string[] = [];

      if (!args.approval.confirmed || approvedIds.size === 0) {
        return blockedResult(targetDocId, "Explicit approval with approvedActionIds is required.");
      }

      const currentCells = await loadCurrentTargetCells(targetDocId, parseTargetDocument);
      const currentCellIndex = buildCurrentCellIndex(currentCells);

      for (const action of plan.actions) {
        if (!approvedIds.has(action.actionId)) {
          results.push(createSkippedResult(action, "Action was not included in approvedActionIds."));
          continue;
        }

        const blockReason = validateApprovedActionForWrite(action, options, dryRunGate);
        if (blockReason) {
          results.push(createBlockedResult(action, blockReason));
          if (options.stopOnFirstError) break;
          continue;
        }

        if (action.type === "skip") {
          results.push(createSkippedResult(action, "skip action is not written."));
          continue;
        }

        const expectedText = getExpectedText(action);
        const currentCell = action.target ? findCurrentCell(action.target, currentCellIndex) : undefined;
        if (!currentCell) {
          results.push(createBlockedResult(action, "Current target cell not found by structured tableIndex/row/col."));
          if (options.stopOnFirstError) break;
          continue;
        }
        if (!currentCell.ref) {
          results.push(createBlockedResult(action, "Current target cell has no SDK ref."));
          if (options.stopOnFirstError) break;
          continue;
        }

        try {
          const beforeText = currentCell.text;
          await writeCellText(targetDocId, currentCell.ref, expectedText);
          results.push({
            actionId: action.actionId,
            status: "applied",
            target: {
              tableIndex: currentCell.tableIndex,
              row: currentCell.row,
              col: currentCell.col,
              ref: currentCell.ref,
              nodeId: currentCell.nodeId,
            },
            valuePreview: truncateText(expectedText),
            beforeTextPreview: truncateText(beforeText),
            afterTextPreview: truncateText(expectedText),
            reason: "setText completed using current SDK ref resolved from parseDocument.",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          results.push({
            actionId: action.actionId,
            status: "failed",
            target: action.target,
            valuePreview: truncateText(expectedText),
            error: message,
          });
          if (options.stopOnFirstError) break;
        }
      }

      if (options.verifyAfterWrite) {
        warnings.push("verifyAfterWrite is not executed in this minimal stage; run verify_docx explicitly with the same candidate_only plan.");
      }

      return buildWriteResult(targetDocId, results, warnings, errors);
    },
  };
}

function parseCandidatePlan(input: unknown): ReturnType<typeof CandidateFillPlanSchema.safeParse> {
  const record = asRecord(input);
  const plan = record && asRecord(record.plan) ? record.plan : input;
  return CandidateFillPlanSchema.safeParse(plan);
}

function resolveTargetDocId(args: WriteDocxArgs, context: ToolExecutionContext): string | undefined {
  const record = asRecord(args.plan);
  return args.targetDocId || stringValue(record?.targetDocId) || context.targetDocId || context.docId;
}

function resolveReferenceDocId(args: WriteDocxArgs): string | undefined {
  const record = asRecord(args.plan);
  return stringValue(record?.referenceDocId);
}

function validateApprovedActionForWrite(
  action: FillPlanAction,
  options: WriteDocxOptions,
  dryRunGate: DryRunGate
): string | undefined {
  if (dryRunGate.blockedActionIds.has(action.actionId) || dryRunGate.invalidActionIds.has(action.actionId)) {
    return `dryRunResult blocks action: ${action.actionId}`;
  }
  if (action.type === "needs_review" && !options.allowNeedsReview) {
    return `needs_review action is not allowed without allowNeedsReview=true: ${action.actionId}`;
  }
  if (action.confidence < 0.75 && !options.allowLowConfidence) {
    return `low-confidence action is not allowed without allowLowConfidence=true: ${action.actionId}`;
  }
  if ((action.type === "fill_cell" || action.type === "copy_text" || action.type === "needs_review") && !action.target) {
    return `${action.type} action requires target: ${action.actionId}`;
  }
  if ((action.type === "fill_cell" || action.type === "copy_text" || action.type === "needs_review") && !getExpectedText(action)) {
    return `${action.type} action requires non-empty expected text: ${action.actionId}`;
  }
  if ((action.type === "fill_cell" || action.type === "copy_text" || action.type === "needs_review") && !hasStructuredCoordinates(action.target)) {
    return `${action.type} action requires structured tableIndex/row/col: ${action.actionId}`;
  }
  return undefined;
}

function inspectDryRun(input: unknown): DryRunGate {
  const record = asRecord(input);
  const issues = Array.isArray(record?.issues) ? record.issues : [];
  const checkedActions = Array.isArray(record?.checkedActions) ? record.checkedActions : [];
  const blockedActionIds = new Set<string>();
  const invalidActionIds = new Set<string>();
  let blockedDuplicateTarget = false;

  for (const item of checkedActions) {
    const checked = asRecord(item);
    const actionId = stringValue(checked?.actionId);
    const status = stringValue(checked?.status);
    if (!actionId) continue;
    if (status === "blocked") blockedActionIds.add(actionId);
    if (status === "invalid") invalidActionIds.add(actionId);
  }

  for (const item of issues) {
    const issue = asRecord(item);
    const actionId = stringValue(issue?.actionId);
    const severity = stringValue(issue?.severity);
    const code = stringValue(issue?.code);
    if (actionId && severity === "blocked") blockedActionIds.add(actionId);
    if (actionId && severity === "error") invalidActionIds.add(actionId);
    if (code === "DUPLICATE_TARGET" && severity === "blocked") blockedDuplicateTarget = true;
  }

  return {
    status: stringValue(record?.status),
    blockedActionIds,
    invalidActionIds,
    blockedDuplicateTarget,
  };
}

async function loadCurrentTargetCells(
  targetDocId: string,
  parseTargetDocument: NonNullable<WriteDocxToolDependencies["parseTargetDocument"]>
): Promise<CurrentCell[]> {
  const payload = await parseTargetDocument(targetDocId);
  return payload.tables.flatMap(table => table.cells.map(toCurrentCell));
}

function toCurrentCell(cell: RawCell): CurrentCell {
  return {
    tableIndex: cell.tableIndex,
    row: cell.row,
    col: cell.col,
    ref: cell.ref || undefined,
    nodeId: cell.nodeId || undefined,
    text: cell.text || "",
  };
}

function buildCurrentCellIndex(cells: CurrentCell[]): Map<string, CurrentCell> {
  const index = new Map<string, CurrentCell>();
  for (const cell of cells) {
    index.set(structuredTargetKey(cell), cell);
  }
  return index;
}

function findCurrentCell(target: FillPlanEndpoint, index: Map<string, CurrentCell>): CurrentCell | undefined {
  if (!hasStructuredCoordinates(target)) return undefined;
  return index.get(structuredTargetKey(target));
}

function hasStructuredCoordinates(target: FillPlanEndpoint | undefined): target is FillPlanEndpoint & { tableIndex: number; row: number; col: number } {
  return typeof target?.tableIndex === "number"
    && typeof target.row === "number"
    && typeof target.col === "number";
}

function structuredTargetKey(target: { tableIndex: number; row: number; col: number }): string {
  return `${target.tableIndex}:${target.row}:${target.col}`;
}

function getExpectedText(action: FillPlanAction): string {
  return normalizeText(action.valuePreview || action.source?.textPreview || "");
}

function buildWriteResult(
  targetDocId: string,
  results: WriteResultItem[],
  warnings: string[],
  errors: string[]
): WriteDocxResult {
  const appliedActionCount = results.filter(result => result.status === "applied").length;
  const skippedActionCount = results.filter(result => result.status === "skipped").length;
  const failedActionCount = results.filter(result => result.status === "failed").length;
  const blockedActionCount = results.filter(result => result.status === "blocked").length;
  const attemptedActionCount = appliedActionCount + failedActionCount;
  const status: WriteDocxResult["status"] = appliedActionCount > 0 && failedActionCount === 0 && blockedActionCount === 0
    ? "success"
    : appliedActionCount > 0
      ? "partial"
      : blockedActionCount > 0
        ? "blocked"
        : "failed";

  return {
    status,
    targetDocId,
    attemptedActionCount,
    appliedActionCount,
    skippedActionCount,
    failedActionCount,
    blockedActionCount,
    results,
    warnings,
    errors,
    verificationSuggestion: "Run verify_docx with the same candidate_only plan to confirm the current DOCX content.",
  };
}

function blockedResult(targetDocId: string, reason: string): WriteDocxResult {
  return {
    status: "blocked",
    targetDocId,
    attemptedActionCount: 0,
    appliedActionCount: 0,
    skippedActionCount: 0,
    failedActionCount: 0,
    blockedActionCount: 1,
    results: [{
      actionId: "write_docx_guard",
      status: "blocked",
      reason,
    }],
    warnings: [],
    errors: [reason],
    verificationSuggestion: "No write was attempted. Fix the blocked condition before running write_docx.",
  };
}

function createSkippedResult(action: FillPlanAction, reason: string): WriteResultItem {
  return {
    actionId: action.actionId,
    status: "skipped",
    target: action.target,
    valuePreview: truncateText(getExpectedText(action)),
    reason,
  };
}

function createBlockedResult(action: FillPlanAction, reason: string): WriteResultItem {
  return {
    actionId: action.actionId,
    status: "blocked",
    target: action.target,
    valuePreview: truncateText(getExpectedText(action)),
    reason,
  };
}

function permissionName(): "write" {
  return "write";
}

function normalizeText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength = 200): string {
  const text = normalizeText(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
