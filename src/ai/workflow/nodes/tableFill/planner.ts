import { randomUUID } from "crypto";
import type { ExecutionPlan, FillPlan, CandidateTarget } from "../docAnalyst/types";
import type { TableFillAnalysis, TableCellRef, TableFillPlanStats } from "./types";

export function buildLayoutBasedExecutionPlan(
  analysis: TableFillAnalysis,
): { plan: ExecutionPlan; stats: TableFillPlanStats } {
  const fillPlans: FillPlan[] = [];
  const failedReasons = [...analysis.failedReasons];
  let lowConfidenceCount = 0;

  for (const template of analysis.templates) {
    const targetCell = findTargetCell(analysis, template.tableIndex, template.row, template.col);
    if (!targetCell) {
      failedReasons.push(`No target cell at table ${template.tableIndex}, row ${template.row}, col ${template.col} for ${template.fieldPath}`);
      continue;
    }

    const confidence = scoreTargetCell(targetCell, template.confidence);
    if (confidence < 0.8) lowConfidenceCount++;

    const selectedTarget: CandidateTarget = {
      nodeId: targetCell.nodeId,
      ref: targetCell.ref,
      tableIndex: targetCell.tableIndex,
      row: targetCell.row,
      col: targetCell.col,
      confidence,
      reason: `matched by reference layout position table=${template.tableIndex}, row=${template.row}, col=${template.col}`,
      constraintScores: new Map([["layout_position", confidence]]),
      copyStyleFromReferenceNodeId: template.referenceNodeId,
    };

    fillPlans.push({
      fieldId: template.fieldPath,
      semanticMeaning: template.value,
      candidateTargets: [selectedTarget],
      selectedTarget,
      confidence,
      constraints: [{ type: "single_target", weight: 1 }],
      sectionContext: `reference:${template.referenceNodeId}`,
    });
  }

  const mappedCount = fillPlans.filter(plan => plan.selectedTarget).length;
  const plan: ExecutionPlan = {
    planId: `layout_plan_${randomUUID()}`,
    docId: analysis.targetDocId,
    schemaId: analysis.analysisId,
    fillPlans,
    metadata: {
      totalFields: analysis.templates.length + analysis.failedReasons.length,
      highConfidenceCount: fillPlans.filter(plan => plan.confidence >= 0.8).length,
      mappedCount,
      lowConfidenceCount,
      failedReasons,
      generatedAt: new Date().toISOString(),
    },
  };

  return {
    plan,
    stats: {
      recognizedFields: plan.metadata.totalFields,
      mappedFields: mappedCount,
      lowConfidenceCount,
      failedReasons,
    },
  };
}

function findTargetCell(
  analysis: TableFillAnalysis,
  tableIndex: number,
  row: number,
  col: number,
): TableCellRef | undefined {
  return analysis.target.tables
    .find(table => table.index === tableIndex)
    ?.cells.find(cell => cell.row === row && cell.col === col);
}

function scoreTargetCell(cell: TableCellRef, templateConfidence: number): number {
  const emptyBonus = cell.text.trim() ? -0.2 : 0;
  return Math.max(0, Math.min(1, templateConfidence + emptyBonus));
}
