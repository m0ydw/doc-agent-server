/**
 * ================================================================
 * TemplateMapper — 已废弃
 * ================================================================
 *
 * 此模块已被 ExecutionPlanner 替代。
 * 新的匹配逻辑在 executionPlanner/matcher.ts 中实现。
 */

// 保留空导出以避免破坏现有导入
export interface FieldMapping {
  fieldName: string;
  userValue: string;
  labelCell: { row: number; col: number; ref: string; text: string };
  targetCell: { row: number; col: number; ref: string; confidence: "high" | "medium" | "low" };
  status: "pending" | "written" | "blocked" | "failed";
  errorReason?: string;
}

export interface MappingResult {
  mappings: FieldMapping[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    unmatchedFields: string[];
  };
}

/** @deprecated Use ExecutionPlanner instead */
export function buildFieldMappings(): MappingResult {
  return {
    mappings: [],
    summary: { total: 0, matched: 0, unmatched: 0, unmatchedFields: [] },
  };
}

/** @deprecated Use ExecutionPlanner instead */
export function allMappingsDone(): boolean {
  return true;
}

/** @deprecated Use ExecutionPlanner instead */
export function getMappingStats() {
  return { total: 0, written: 0, blocked: 0, failed: 0, pending: 0 };
}
