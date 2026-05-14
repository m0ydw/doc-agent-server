import { z } from "zod";
import { fileRegistry } from "../../../services/fileRegistry";
import { parseDocument } from "../../workflow/nodes/docAnalyst/parser";
import type { RawCell, RawTable } from "../../workflow/nodes/docAnalyst/types";
import type { ToolDefinition, ToolExecutionContext } from "../toolTypes";

export const GenerateFillPlanArgsSchema = z.object({
  referenceDocId: z.string().optional(),
  targetDocId: z.string().optional(),
  docId: z.string().optional(),
  referenceTemplates: z.unknown().optional(),
  targetInspection: z.unknown().optional(),
  userGoal: z.string().optional(),
  preferHighConfidenceOnly: z.boolean().optional().default(false),
  includeDiagnostics: z.boolean().optional().default(true),
  includeRaw: z.boolean().optional().default(false),
  maxActions: z.number().int().positive().optional().default(200),
  maxWarnings: z.number().int().positive().optional().default(100),
});

export const FillPlanEndpointSchema = z.object({
  docId: z.string().optional(),
  tableIndex: z.number().optional(),
  row: z.number().optional(),
  col: z.number().optional(),
  textPreview: z.string().optional(),
  ref: z.string().optional(),
  nodeId: z.string().optional(),
});

export const FillPlanActionSchema = z.object({
  actionId: z.string(),
  type: z.enum(["fill_cell", "copy_text", "skip", "needs_review"]),
  source: FillPlanEndpointSchema.optional(),
  target: FillPlanEndpointSchema.optional(),
  label: z.string().optional(),
  valuePreview: z.string().optional(),
  confidence: z.number(),
  reason: z.string(),
  risks: z.array(z.string()).optional(),
});

export const CandidateFillPlanSchema = z.object({
  version: z.string(),
  mode: z.literal("candidate_only"),
  actions: z.array(FillPlanActionSchema),
  unresolvedFields: z.array(z.object({
    label: z.string().optional(),
    reason: z.string(),
    sourcePreview: z.string().optional(),
  })).optional(),
  conflicts: z.array(z.object({
    reason: z.string(),
    actionIds: z.array(z.string()).optional(),
  })).optional(),
});

export const GenerateFillPlanResultSchema = z.object({
  status: z.enum(["success", "partial", "blocked", "failed"]),
  referenceDocId: z.string().optional(),
  targetDocId: z.string().optional(),
  plan: CandidateFillPlanSchema,
  diagnostics: z.object({
    referenceTableCount: z.number().optional(),
    targetTableCount: z.number().optional(),
    generatedActionCount: z.number().optional(),
    highConfidenceActionCount: z.number().optional(),
    needsReviewActionCount: z.number().optional(),
    skippedActionCount: z.number().optional(),
  }).optional(),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  raw: z.unknown().optional(),
});

export type GenerateFillPlanArgs = z.infer<typeof GenerateFillPlanArgsSchema>;
export type GenerateFillPlanResult = z.infer<typeof GenerateFillPlanResultSchema>;
export type FillPlanEndpoint = z.infer<typeof FillPlanEndpointSchema>;
export type FillPlanAction = z.infer<typeof FillPlanActionSchema>;
export type CandidateFillPlan = z.infer<typeof CandidateFillPlanSchema>;

interface ReferenceField {
  label: string;
  valuePreview?: string;
  source?: {
    docId?: string;
    tableIndex?: number;
    row?: number;
    col?: number;
    textPreview?: string;
    ref?: string;
    nodeId?: string;
  };
}

interface TargetSlot {
  label: string;
  target: {
    docId?: string;
    tableIndex?: number;
    row?: number;
    col?: number;
    ref?: string;
    nodeId?: string;
  };
  reason: string;
}

export function createGenerateFillPlanTool(): ToolDefinition<
  typeof GenerateFillPlanArgsSchema,
  typeof GenerateFillPlanResultSchema
> {
  return {
    name: "generate_fill_plan",
    description:
      "Diagnostic planning tool that generates candidate-only fill actions from reference templates and target table structure. It never writes to DOCX and never executes the plan.",
    permission: "diagnostic",
    argsSchema: GenerateFillPlanArgsSchema,
    resultSchema: GenerateFillPlanResultSchema,
    guard: (args, context) => {
      const referenceDocId = resolveReferenceDocId(args, context);
      const targetDocId = resolveTargetDocId(args, context);

      if (!args.referenceTemplates && !referenceDocId) {
        return { allowed: false, reason: "Missing referenceTemplates or referenceDocId." };
      }
      if (!args.targetInspection && !targetDocId) {
        return { allowed: false, reason: "Missing targetInspection or targetDocId." };
      }
      if (referenceDocId && !fileRegistry.get(referenceDocId)) {
        return { allowed: false, reason: `Reference document not found in registry: ${referenceDocId}` };
      }
      if (targetDocId && !fileRegistry.get(targetDocId)) {
        return { allowed: false, reason: `Target document not found in registry: ${targetDocId}` };
      }
      if (referenceDocId && targetDocId && referenceDocId === targetDocId) {
        return { allowed: false, reason: "referenceDocId and targetDocId must be different for fill planning." };
      }
      if (!args.referenceTemplates && !args.targetInspection && fileRegistry.count === 1) {
        return { allowed: false, reason: "Only one document is available; explicit reference and target documents are required." };
      }

      return { allowed: true };
    },
    execute: async (args, context) => {
      const referenceDocId = resolveReferenceDocId(args, context);
      const targetDocId = resolveTargetDocId(args, context);
      const warnings: string[] = [];

      const referenceFields = args.referenceTemplates
        ? extractReferenceFieldsFromUnknown(args.referenceTemplates, referenceDocId, warnings)
        : await extractReferenceFieldsFromDocument(referenceDocId, warnings);

      const targetSlots = args.targetInspection
        ? extractTargetSlotsFromUnknown(args.targetInspection, targetDocId, warnings)
        : await extractTargetSlotsFromDocument(targetDocId, warnings);

      const actions: GenerateFillPlanResult["plan"]["actions"] = [];
      const unresolvedFields: NonNullable<GenerateFillPlanResult["plan"]["unresolvedFields"]> = [];
      const usedTargets = new Map<string, string[]>();

      for (const field of referenceFields) {
        const match = findBestTarget(field, targetSlots);
        if (!match) {
          unresolvedFields.push({
            label: field.label,
            reason: "No matching target label or fillable neighbor found.",
            sourcePreview: field.valuePreview,
          });
          continue;
        }

        if (args.preferHighConfidenceOnly && match.confidence < 0.75) {
          unresolvedFields.push({
            label: field.label,
            reason: `Matched target confidence too low: ${match.confidence.toFixed(2)}`,
            sourcePreview: field.valuePreview,
          });
          continue;
        }

        if (actions.length >= args.maxActions) {
          warnings.push(`Actions truncated at maxActions=${args.maxActions}`);
          break;
        }

        const actionId = createActionId(actions.length + 1);
        const risks = match.confidence < 0.75 ? ["low_confidence_match"] : undefined;
        actions.push({
          actionId,
          type: match.confidence >= 0.75 ? "fill_cell" : "needs_review",
          source: field.source,
          target: match.slot.target,
          label: field.label,
          valuePreview: field.valuePreview,
          confidence: match.confidence,
          reason: match.reason,
          risks,
        });

        const targetKey = makeTargetKey(match.slot.target);
        const ids = usedTargets.get(targetKey) || [];
        ids.push(actionId);
        usedTargets.set(targetKey, ids);
      }

      const conflicts = Array.from(usedTargets.entries())
        .filter(([, actionIds]) => actionIds.length > 1)
        .map(([targetKey, actionIds]) => ({
          reason: `Multiple actions target the same cell: ${targetKey}`,
          actionIds,
        }));

      const limitedWarnings = warnings.slice(0, args.maxWarnings);
      const highConfidenceActionCount = actions.filter(action => action.confidence >= 0.75).length;
      const needsReviewActionCount = actions.filter(action => action.type === "needs_review").length;
      const skippedActionCount = unresolvedFields.length;
      const status: GenerateFillPlanResult["status"] = actions.length === 0
        ? "blocked"
        : unresolvedFields.length > 0 || conflicts.length > 0 || warnings.length > 0
          ? "partial"
          : "success";

      const result: GenerateFillPlanResult = {
        status,
        referenceDocId,
        targetDocId,
        plan: {
          version: "tool-agent-plan-v1",
          mode: "candidate_only",
          actions,
          unresolvedFields,
          conflicts,
        },
        diagnostics: args.includeDiagnostics ? {
          generatedActionCount: actions.length,
          highConfidenceActionCount,
          needsReviewActionCount,
          skippedActionCount,
        } : undefined,
        summary: `candidate_only plan: actions=${actions.length}, unresolved=${unresolvedFields.length}, conflicts=${conflicts.length}`,
        warnings: limitedWarnings,
      };

      if (args.includeRaw) {
        result.raw = {
          referenceFieldCount: referenceFields.length,
          targetSlotCount: targetSlots.length,
          warningCount: warnings.length,
        };
      }

      return result;
    },
  };
}

function resolveReferenceDocId(args: GenerateFillPlanArgs, context: ToolExecutionContext): string | undefined {
  return args.referenceDocId || context.referenceDocId;
}

function resolveTargetDocId(args: GenerateFillPlanArgs, context: ToolExecutionContext): string | undefined {
  return args.targetDocId || context.targetDocId || context.docId || args.docId;
}

async function extractReferenceFieldsFromDocument(
  referenceDocId: string | undefined,
  warnings: string[]
): Promise<ReferenceField[]> {
  if (!referenceDocId) return [];
  const payload = await parseDocument(referenceDocId, true);
  return extractReferenceFieldsFromTables(payload.tables, referenceDocId, warnings);
}

async function extractTargetSlotsFromDocument(
  targetDocId: string | undefined,
  warnings: string[]
): Promise<TargetSlot[]> {
  if (!targetDocId) return [];
  const payload = await parseDocument(targetDocId, true);
  return extractTargetSlotsFromTables(payload.tables, targetDocId, warnings);
}

function extractReferenceFieldsFromUnknown(input: unknown, docId: string | undefined, warnings: string[]): ReferenceField[] {
  const record = asRecord(input);
  const templates = Array.isArray(record?.templates) ? record.templates : [];
  const fields: ReferenceField[] = [];

  for (const template of templates) {
    const table = asRecord(template);
    const candidates = Array.isArray(table?.fieldCandidates) ? table.fieldCandidates : [];
    for (const candidate of candidates) {
      const item = asRecord(candidate);
      const label = stringValue(item?.label);
      if (!label) continue;
      fields.push({
        label,
        valuePreview: stringValue(item?.valuePreview),
        source: {
          docId,
          tableIndex: numberValue(item?.tableIndex),
          row: numberValue(item?.row),
          col: numberValue(item?.col),
          textPreview: stringValue(item?.valuePreview),
          ref: stringValue(item?.ref),
          nodeId: stringValue(item?.nodeId),
        },
      });
    }
  }

  if (fields.length === 0) warnings.push("No reference fieldCandidates found in provided referenceTemplates.");
  return fields;
}

function extractTargetSlotsFromUnknown(input: unknown, docId: string | undefined, warnings: string[]): TargetSlot[] {
  const record = asRecord(input);
  const tables = Array.isArray(record?.tables) ? record.tables : [];
  const allCells: RawCell[] = [];

  for (const table of tables) {
    const tableRecord = asRecord(table);
    const cells = Array.isArray(tableRecord?.cells) ? tableRecord.cells : [];
    for (const cell of cells) {
      const item = asRecord(cell);
      allCells.push({
        tableIndex: numberValue(item?.tableIndex) ?? numberValue(tableRecord?.index) ?? 0,
        row: numberValue(item?.row) ?? 0,
        col: numberValue(item?.col) ?? 0,
        ref: stringValue(item?.ref) || "",
        nodeId: stringValue(item?.nodeId) || "",
        text: stringValue(item?.textPreview) || "",
        rowspan: 1,
        colspan: 1,
      });
    }
  }

  if (allCells.length === 0) warnings.push("No target cells found in provided targetInspection.");
  return extractTargetSlotsFromTables([{ index: 0, rows: 0, cols: 0, cells: allCells }], docId, warnings);
}

function extractReferenceFieldsFromTables(tables: RawTable[], docId: string | undefined, _warnings: string[]): ReferenceField[] {
  const fields: ReferenceField[] = [];
  for (const table of tables) {
    for (const cell of table.cells) {
      const labelValue = splitLabelValue(cell.text);
      if (labelValue) {
        fields.push({
          label: labelValue.label,
          valuePreview: labelValue.value || undefined,
          source: cellEndpoint(docId, cell, cell.text),
        });
        continue;
      }

      if (!isLikelyLabel(cell.text)) continue;
      const valueCell = findAdjacentCell(table.cells, cell, true);
      fields.push({
        label: cleanLabel(cell.text),
        valuePreview: valueCell?.text,
        source: cellEndpoint(docId, cell, valueCell?.text || cell.text),
      });
    }
  }
  return dedupeFields(fields);
}

function extractTargetSlotsFromTables(tables: RawTable[], docId: string | undefined, _warnings: string[]): TargetSlot[] {
  const slots: TargetSlot[] = [];
  for (const table of tables) {
    for (const cell of table.cells) {
      const labelValue = splitLabelValue(cell.text);
      const label = labelValue?.label || (isLikelyLabel(cell.text) ? cleanLabel(cell.text) : "");
      if (!label) continue;
      const targetCell = findAdjacentCell(table.cells, cell, false);
      if (!targetCell) continue;
      slots.push({
        label,
        target: {
          docId,
          tableIndex: targetCell.tableIndex,
          row: targetCell.row,
          col: targetCell.col,
          ref: targetCell.ref,
          nodeId: targetCell.nodeId,
        },
        reason: "target label with right/bottom fillable neighbor",
      });
    }
  }
  return slots;
}

function findBestTarget(field: ReferenceField, slots: TargetSlot[]): { slot: TargetSlot; confidence: number; reason: string } | null {
  let best: { slot: TargetSlot; confidence: number; reason: string } | null = null;
  for (const slot of slots) {
    const match = scoreLabelMatch(field.label, slot.label);
    if (!match || (best && match.confidence <= best.confidence)) continue;
    best = {
      slot,
      confidence: match.confidence,
      reason: `${match.reason}; ${slot.reason}`,
    };
  }
  return best;
}

function scoreLabelMatch(sourceLabel: string, targetLabel: string): { confidence: number; reason: string } | null {
  const source = normalizeLabel(sourceLabel);
  const target = normalizeLabel(targetLabel);
  if (!source || !target) return null;
  if (source === target) return { confidence: 0.9, reason: "exact normalized label match" };
  if (source.includes(target) || target.includes(source)) return { confidence: 0.8, reason: "partial normalized label match" };
  if (aliases(source).some(alias => aliases(target).includes(alias))) return { confidence: 0.7, reason: "field alias match" };
  return null;
}

function splitLabelValue(text: string): { label: string; value: string } | null {
  const normalized = normalizeWhitespace(text);
  const match = normalized.match(/^(.{1,40}?)[：:]\s*(.*)$/);
  if (!match) return null;
  return { label: cleanLabel(match[1]), value: normalizeWhitespace(match[2]) };
}

function isLikelyLabel(text: string): boolean {
  const normalized = cleanLabel(text);
  if (!normalized || normalized.length > 30) return false;
  return /姓名|名称|电话|手机|邮箱|日期|编号|地址|学校|年级|专业|职务|方向|项目|类型|Name|Date|Address|Phone|Email|ID|School|Major/i.test(normalized);
}

function findAdjacentCell(cells: RawCell[], labelCell: RawCell, allowNonEmpty: boolean): RawCell | undefined {
  const right = cells.find(cell =>
    cell.tableIndex === labelCell.tableIndex &&
    cell.row === labelCell.row &&
    cell.col === labelCell.col + labelCell.colspan &&
    isFillableCandidate(cell, allowNonEmpty)
  );
  if (right) return right;

  return cells.find(cell =>
    cell.tableIndex === labelCell.tableIndex &&
    cell.row === labelCell.row + labelCell.rowspan &&
    cell.col === labelCell.col &&
    isFillableCandidate(cell, allowNonEmpty)
  );
}

function isFillableCandidate(cell: RawCell, allowNonEmpty: boolean): boolean {
  const text = normalizeWhitespace(cell.text);
  return allowNonEmpty || text.length <= 3;
}

function cellEndpoint(docId: string | undefined, cell: RawCell, textPreview?: string): ReferenceField["source"] {
  return {
    docId,
    tableIndex: cell.tableIndex,
    row: cell.row,
    col: cell.col,
    textPreview: textPreview ? normalizeWhitespace(textPreview).slice(0, 200) : undefined,
    ref: cell.ref,
    nodeId: cell.nodeId,
  };
}

function dedupeFields(fields: ReferenceField[]): ReferenceField[] {
  const seen = new Set<string>();
  const result: ReferenceField[] = [];
  for (const field of fields) {
    const key = `${normalizeLabel(field.label)}:${field.source?.tableIndex}:${field.source?.row}:${field.source?.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(field);
  }
  return result;
}

function makeTargetKey(target: NonNullable<GenerateFillPlanResult["plan"]["actions"][number]["target"]>): string {
  return `${target.docId || ""}:${target.tableIndex ?? ""}:${target.row ?? ""}:${target.col ?? ""}:${target.ref || target.nodeId || ""}`;
}

function createActionId(index: number): string {
  return `candidate_fill_${String(index).padStart(4, "0")}`;
}

function cleanLabel(text: string): string {
  return normalizeWhitespace(text).replace(/[：:]\s*$/, "");
}

function normalizeLabel(text: string): string {
  return cleanLabel(text).toLowerCase().replace(/[\s_\-:：/／]/g, "");
}

function normalizeWhitespace(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function aliases(label: string): string[] {
  const normalized = normalizeLabel(label);
  const groups = [
    ["姓名", "name"],
    ["电话", "手机", "phone", "tel", "mobile"],
    ["邮箱", "email", "mail"],
    ["日期", "date"],
    ["地址", "address"],
    ["编号", "id"],
    ["学校", "school"],
    ["专业", "major"],
  ];
  const group = groups.find(items => items.includes(normalized));
  return group || [normalized];
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
