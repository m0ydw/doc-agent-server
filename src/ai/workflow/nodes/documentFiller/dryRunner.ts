/**
 * ================================================================
 * Dry Runner
 * ================================================================
 *
 * 模拟执行，验证计划可行性
 */

import type { ExecutionPlan, FillPlan, DryRunResult, ValidationResult } from "./types";

/**
 * 冲突组详情
 */
interface DuplicateGroup {
  targetKey: string;
  count: number;
  actions: Array<{
    fieldName: string;
    text: string;
    targetNodeId: string;
    tableIndex: number;
    rowIndex: number;
    colIndex: number;
    sourceTemplate: string;
    reason: string;
  }>;
}

/**
 * 执行 dry-run
 */
export function executeDryRun(plan: ExecutionPlan): DryRunResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 检查每个 fill plan
  for (const fillPlan of plan.fillPlans) {
    const validation = validateFillPlan(fillPlan);
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
  }

  // 检查是否有重复目标（使用 nodeId 优先）
  const duplicateGroups = detectDuplicateTargets(plan);
  if (duplicateGroups.length > 0) {
    for (const group of duplicateGroups) {
      errors.push(`Duplicate target: ${group.targetKey} (${group.count} actions)`);
      // 输出详细的冲突组信息
      console.error(`[DryRunner] ❌ 重复目标详情:`);
      console.error(`[DryRunner]   targetKey: ${group.targetKey}`);
      console.error(`[DryRunner]   冲突数量: ${group.count}`);
      console.error(`[DryRunner]   冲突动作:`);
      for (const action of group.actions) {
        console.error(`[DryRunner]     - ${action.fieldName}: "${action.text}"`);
        console.error(`[DryRunner]       nodeId=${action.targetNodeId}, table=${action.tableIndex}, row=${action.rowIndex}, col=${action.colIndex}`);
        console.error(`[DryRunner]       reason=${action.reason}`);
      }
    }
  }

  // 统计有效写入数
  const estimatedWrites = plan.fillPlans.filter(
    p => p.selectedTarget && p.confidence >= 0.5
  ).length;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    estimatedWrites,
  };
}

/**
 * 检测重复目标
 */
function detectDuplicateTargets(plan: ExecutionPlan): DuplicateGroup[] {
  const targetMap = new Map<string, DuplicateGroup>();

  for (const fillPlan of plan.fillPlans) {
    if (!fillPlan.selectedTarget) continue;

    // 优先使用 nodeId 作为 targetKey
    const targetKey = fillPlan.selectedTarget.nodeId
      || `${fillPlan.selectedTarget.tableIndex ?? 0}_${fillPlan.selectedTarget.row}_${fillPlan.selectedTarget.col}`;

    if (!targetMap.has(targetKey)) {
      targetMap.set(targetKey, {
        targetKey,
        count: 0,
        actions: [],
      });
    }

    const group = targetMap.get(targetKey)!;
    group.count++;
    group.actions.push({
      fieldName: fillPlan.fieldId,
      text: fillPlan.semanticMeaning,
      targetNodeId: fillPlan.selectedTarget.nodeId,
      tableIndex: fillPlan.selectedTarget.tableIndex ?? 0,
      rowIndex: fillPlan.selectedTarget.row,
      colIndex: fillPlan.selectedTarget.col,
      sourceTemplate: fillPlan.sectionContext,
      reason: fillPlan.selectedTarget.reason,
    });
  }

  // 只返回有重复的组
  return [...targetMap.values()].filter(group => group.count > 1);
}

/**
 * 验证 fill plan
 */
function validateFillPlan(fillPlan: FillPlan): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 检查是否有选中的目标
  if (!fillPlan.selectedTarget) {
    warnings.push(`No target selected for field: ${fillPlan.fieldId}`);
  }

  // 检查置信度
  if (fillPlan.confidence < 0.3) {
    warnings.push(`Low confidence for field: ${fillPlan.fieldId} (${fillPlan.confidence})`);
  }

  // 检查语义含义
  if (!fillPlan.semanticMeaning || fillPlan.semanticMeaning.trim() === "") {
    errors.push(`Empty semantic meaning for field: ${fillPlan.fieldId}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
