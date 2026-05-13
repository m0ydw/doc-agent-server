/**
 * ================================================================
 * Dry Runner
 * ================================================================
 *
 * 模拟执行，验证计划可行性
 */

import type { ExecutionPlan, FillPlan, DryRunResult, ValidationResult } from "./types";

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

  // 检查是否有重复目标
  const usedTargets = new Set<string>();
  for (const fillPlan of plan.fillPlans) {
    if (fillPlan.selectedTarget) {
      const targetKey = `${fillPlan.selectedTarget.tableIndex ?? 0}_${fillPlan.selectedTarget.row}_${fillPlan.selectedTarget.col}`;
      if (usedTargets.has(targetKey)) {
        errors.push(`Duplicate target: ${targetKey}`);
      }
      usedTargets.add(targetKey);
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
