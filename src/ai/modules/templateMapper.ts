/**
 * TemplateMapper — 模板映射器
 *
 * 根据 DocumentMap（来自 DocAnalyst）和用户提取数据（来自 DataExtractor），
 * 建立"字段 → 写入目标 ref"的映射表。
 *
 * 核心逻辑：
 *   1. 从 DocumentMap 中获取 LabelMapping[]（标签→目标格）
 *   2. 遍历用户数据字段，匹配标签名
 *   3. 生成 FieldMapping[]（字段名、用户值、目标 ref、状态）
 *
 * 这是一个纯确定性模块，不包含 LLM 调用。
 */

import type { DocumentMap, LabelMapping } from "../workflow/nodes/docAnalyst";
import { LABEL_VARIANTS_MAP } from "./fieldConfig";

// ================================================================
// 类型
// ================================================================

export interface FieldMapping {
  /** 字段名（如 "指导教师"） */
  fieldName: string;
  /** 用户提供的原始值 */
  userValue: string;
  /** 标签格信息 */
  labelCell: {
    row: number;
    col: number;
    ref: string;
    text: string;
  };
  /** 目标写入格（来自 DocAnalyst 的微决策结果） */
  targetCell: {
    row: number;
    col: number;
    ref: string;
    confidence: "high" | "medium" | "low";
  };
  /** 写入状态 */
  status: "pending" | "written" | "blocked" | "failed";
  /** 错误原因（仅在 blocked/failed 时） */
  errorReason?: string;
}

export interface MappingResult {
  mappings: FieldMapping[];
  summary: {
    total: number;
    matched: number;    // 成功匹配到标签格的字段数
    unmatched: number;  // 未能匹配的字段名
    unmatchedFields: string[];
  };
}

// ================================================================
// 字段名模糊匹配
// ================================================================

// LABEL_VARIANTS_MAP 现在从共享配置 fieldConfig.ts 导入（不再本地定义）

/**
 * 判断两个字符串是否指向同一字段
 */
function isFieldMatch(userField: string, labelText: string): boolean {
  const uf = userField.trim().toLowerCase();
  const lt = labelText.trim().toLowerCase();

  // 精确匹配
  if (uf === lt) return true;

  // 变体匹配（使用共享配置）
  const variants = LABEL_VARIANTS_MAP[userField] || [userField];
  for (const variant of variants) {
    if (variant.toLowerCase() === lt) return true;
  }

  // 包含匹配
  if (uf.includes(lt) || lt.includes(uf)) return true;

  return false;
}

// ================================================================
// 主映射函数
// ================================================================

/**
 * 将用户数据映射到文档表中的目标单元格
 *
 * @param documentMap - DocAnalyst 产出的文档结构地图
 * @param extractedData - DataExtractor 提取的用户结构化数据
 * @returns MappingResult
 */
export function buildFieldMappings(
  documentMap: DocumentMap,
  extractedData: Record<string, string>,
): MappingResult {
  const mappings: FieldMapping[] = [];
  const unmatchedFields: string[] = [];

  // 收集所有表格中的标签映射
  const allLabels: LabelMapping[] = [];
  for (const table of documentMap.tables) {
    allLabels.push(...table.labels);
  }

  // 遍历用户数据，为每个字段找标签匹配
  for (const [fieldName, userValue] of Object.entries(extractedData)) {
    if (!userValue || !userValue.trim()) continue;

    // 在标签列表中查找匹配
    let matchedLabel: LabelMapping | undefined;

    for (const label of allLabels) {
      if (isFieldMatch(fieldName, label.label)) {
        matchedLabel = label;
        break;
      }
    }

    if (matchedLabel && matchedLabel.suggestedTarget) {
      mappings.push({
        fieldName,
        userValue: userValue.trim(),
        labelCell: {
          row: matchedLabel.labelCell.row,
          col: matchedLabel.labelCell.col,
          ref: matchedLabel.labelCell.ref,
          text: matchedLabel.label,
        },
        targetCell: {
          row: matchedLabel.suggestedTarget.targetRow,
          col: matchedLabel.suggestedTarget.targetCol,
          ref: matchedLabel.suggestedTarget.targetRef,
          confidence: matchedLabel.suggestedTarget.confidence,
        },
        status: "pending",
      });
    } else {
      unmatchedFields.push(fieldName);
    }
  }

  return {
    mappings,
    summary: {
      total: mappings.length + unmatchedFields.length,
      matched: mappings.length,
      unmatched: unmatchedFields.length,
      unmatchedFields,
    },
  };
}

/**
 * 检查所有映射是否已完成（全部 status in ["written", "blocked", "failed"]）
 */
export function allMappingsDone(mappings: FieldMapping[]): boolean {
  if (mappings.length === 0) return true;
  return mappings.every((m) => m.status !== "pending");
}

/**
 * 获取映射完成统计
 */
export function getMappingStats(mappings: FieldMapping[]): {
  total: number;
  written: number;
  blocked: number;
  failed: number;
  pending: number;
} {
  return {
    total: mappings.length,
    written: mappings.filter((m) => m.status === "written").length,
    blocked: mappings.filter((m) => m.status === "blocked").length,
    failed: mappings.filter((m) => m.status === "failed").length,
    pending: mappings.filter((m) => m.status === "pending").length,
  };
}
