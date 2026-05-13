import { randomUUID } from "crypto";
import type { ExecutionPlan, FillPlan, CandidateTarget } from "../docAnalyst/types";
import type { TableFillAnalysis, TableCellRef, TableFillPlanStats } from "./types";

export function buildLayoutBasedExecutionPlan(
  analysis: TableFillAnalysis,
): { plan: ExecutionPlan; stats: TableFillPlanStats } {
  const fillPlans: FillPlan[] = [];
  const failedReasons = [...analysis.failedReasons];
  let lowConfidenceCount = 0;

  console.log(`[Planner] ========== 开始生成执行计划 ==========`);
  console.log(`[Planner] 共 ${analysis.templates.length} 个模板`);

  for (const template of analysis.templates) {
    // template.tableIndex 已经是 analyzer 映射后的 target tableIndex
    const targetCell = findTargetCell(analysis, template.tableIndex, template.row, template.col);
    if (!targetCell) {
      failedReasons.push(`No target cell at table ${template.tableIndex}, row ${template.row}, col ${template.col} for ${template.fieldPath}`);
      console.warn(`[Planner] ⚠️ 未找到目标单元格: ${template.fieldPath} (target table=${template.tableIndex}, row=${template.row}, col=${template.col})`);
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
      reason: template.reason,
      constraintScores: { layout_position: confidence },
      copyStyleFromReferenceNodeId: template.referenceNodeId,
    };

    // 增强调试日志
    console.log(`[Planner] 模板映射详情:`);
    console.log(`[Planner]   fieldPath: ${template.fieldPath}`);
    console.log(`[Planner]   text: "${template.value}"`);
    console.log(`[Planner]   reason: ${template.reason}`);
    console.log(`[Planner]   target: nodeId=${targetCell.nodeId}, ref=${targetCell.ref}`);
    console.log(`[Planner]   target: table=${targetCell.tableIndex}, row=${targetCell.row}, col=${targetCell.col}`);
    console.log(`[Planner]   confidence: ${confidence.toFixed(2)}`);

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

  // 检测重复目标
  const duplicateTargets = detectDuplicateTargets(fillPlans);
  if (duplicateTargets.size > 0) {
    console.error(`[Planner] ❌ 发现 ${duplicateTargets.size} 个重复目标！`);
    for (const [targetKey, actions] of duplicateTargets) {
      console.error(`[Planner]   目标 ${targetKey} 被 ${actions.length} 个字段占用:`);
      for (const action of actions) {
        console.error(`[Planner]     - ${action.fieldPath}: "${action.text}" (table=${action.tableIndex}, row=${action.row}, col=${action.col})`);
      }
    }
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

  console.log(`[Planner] 执行计划生成完成: ${fillPlans.length} 个写入动作，${duplicateTargets.size} 个重复目标`);

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

function detectDuplicateTargets(fillPlans: FillPlan[]): Map<string, Array<{ fieldPath: string; text: string; tableIndex: number; row: number; col: number }>> {
  const targetMap = new Map<string, Array<{ fieldPath: string; text: string; tableIndex: number; row: number; col: number }>>();

  for (const fillPlan of fillPlans) {
    if (!fillPlan.selectedTarget) continue;

    const targetKey = fillPlan.selectedTarget.nodeId
      || `${fillPlan.selectedTarget.tableIndex ?? 0}_${fillPlan.selectedTarget.row}_${fillPlan.selectedTarget.col}`;

    if (!targetMap.has(targetKey)) {
      targetMap.set(targetKey, []);
    }
    targetMap.get(targetKey)!.push({
      fieldPath: fillPlan.fieldId,
      text: fillPlan.semanticMeaning,
      tableIndex: fillPlan.selectedTarget.tableIndex ?? 0,
      row: fillPlan.selectedTarget.row,
      col: fillPlan.selectedTarget.col,
    });
  }

  return new Map([...targetMap].filter(([_, actions]) => actions.length > 1));
}
