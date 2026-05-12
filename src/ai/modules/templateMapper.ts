/**
 * TemplateMapper — 模板映射器（确定性模块）
 *
 * 桥接 "文档结构地图" 和 "用户数据" 两个数据源，建立写入映射表。
 *
 * 【核心逻辑】
 *   1. 从 DocumentMap 中获取 LabelMapping[]（标签→目标格的映射，由 DocAnalyst 产出）
 *   2. 遍历用户数据字段（来自 DataExtractor），通过模糊匹配匹配标签名
 *   3. 生成 FieldMapping[]（字段名 + 用户值 + 目标 ref + 状态）
 *
 * 【为什么是纯确定性的？】
 * 标签定位和目标格判定已在 DocAnalyst（LLM 微决策）完成，
 * TemplateMapper 只做机械性的字符串匹配和数据组装，不需要 LLM。
 *
 * 【在整体流程中的位置】
 * 由 TemplateFiller 节点调用，在写入操作之前建立"字段→目标格"的映射。
 *
 * 【字段名匹配策略】
 * - 精确匹配（用户字段名 == 标签文本）
 * - 变体匹配（通过 LABEL_VARIANTS_MAP 扩展的别名）
 * - 包含匹配（互相包含即认为匹配）
 */

import type { DocumentMap, LabelMapping } from "../workflow/nodes/docAnalyst";
import { LABEL_VARIANTS_MAP } from "./fieldConfig";

// ================================================================
// 类型定义
// ================================================================

/** 单条字段映射记录 — 描述一个用户字段应该如何写入文档 */
export interface FieldMapping {
  /** 字段名（如 "指导教师"、"联系电话"） */
  fieldName: string;
  /** 用户提供的原始值（待写入文档） */
  userValue: string;
  /** 标签单元格的位置信息（标签在表格的哪个格） */
  labelCell: {
    row: number;
    col: number;
    ref: string;
    text: string;
  };
  /** 目标写入格的位置（DocAnalyst 微决策的结果） */
  targetCell: {
    row: number;
    col: number;
    ref: string;
    /** 置信度 */
    confidence: "high" | "medium" | "low";
  };
  /** 写入状态：pending（待写入）/ written（已写入）/ blocked（被拦截）/ failed（写入失败） */
  status: "pending" | "written" | "blocked" | "failed";
  /** 错误原因（仅在 blocked 或 failed 时有值） */
  errorReason?: string;
}

/** 映射构建结果 */
export interface MappingResult {
  /** 生成的映射记录列表 */
  mappings: FieldMapping[];
  /** 映射构建摘要 */
  summary: {
    /** 用户数据字段总数 */
    total: number;
    /** 成功匹配到标签格的字段数 */
    matched: number;
    /** 未能匹配的字段数 */
    unmatched: number;
    /** 未能匹配的字段名称列表 */
    unmatchedFields: string[];
  };
}

// ================================================================
// 字段名模糊匹配
//
// LABEL_VARIANTS_MAP 现在从共享配置 fieldConfig.ts 导入（不再本地定义）
// ================================================================

/**
 * 判断用户字段名是否与文档标签文本匹配
 *
 * 【三级匹配策略】
 * 1. 精确匹配（忽略大小写和空格）
 * 2. 变体匹配（通过 LABEL_VARIANTS_MAP 扩展，如 "手机" → "电话"）
 * 3. 包含匹配（互为子串也认为匹配）
 *
 * @param userField 用户数据中的字段名（如 "联系电话"）
 * @param labelText 文档标签文本（如 "电话"）
 * @returns 是否匹配
 */
function isFieldMatch(userField: string, labelText: string): boolean {
  const uf = userField.trim().toLowerCase();
  const lt = labelText.trim().toLowerCase();

  // 精确匹配
  if (uf === lt) return true;

  // 变体匹配（使用共享配置 fieldConfig.ts 中的别名映射）
  const variants = LABEL_VARIANTS_MAP[userField] || [userField];
  for (const variant of variants) {
    if (variant.toLowerCase() === lt) return true;
  }

  // 包含匹配（如 "联系电话" 包含 "电话"）
  if (uf.includes(lt) || lt.includes(uf)) return true;

  return false;
}

// ================================================================
// 主映射函数
// ================================================================

/**
 * 构建字段映射表：将用户数据映射到文档表格中的目标单元格
 *
 * 这是 TemplateMapper 的主入口函数，完成"数据→位置"的映射构建。
 * 生成的 FieldMapping[] 随后由 TemplateFiller 逐条执行写入。
 *
 * 【处理流程】
 * 1. 从 DocumentMap 收集所有表格中的标签映射
 * 2. 遍历用户数据字段，对每个字段名做模糊匹配
 * 3. 匹配成功 → 生成 FieldMapping（状态 initial 为 "pending"）
 * 4. 匹配失败 → 记录到 unmatchedFields 中（供后续人工处理）
 *
 * @param documentMap   DocAnalyst 产出的文档结构地图
 * @param extractedData DataExtractor 提取的用户结构化数据
 * @returns MappingResult（映射记录 + 构建摘要）
 */
export function buildFieldMappings(
  documentMap: DocumentMap,
  extractedData: Record<string, string>,
): MappingResult {
  const mappings: FieldMapping[] = [];
  const unmatchedFields: string[] = [];

  // 收集所有表格中的标签映射（支持多表格文档）
  const allLabels: LabelMapping[] = [];
  for (const table of documentMap.tables) {
    allLabels.push(...table.labels);
  }

  // 遍历用户数据，为每个字段找标签匹配
  for (const [fieldName, userValue] of Object.entries(extractedData)) {
    if (!userValue || !userValue.trim()) continue;

    // 在标签列表中查找匹配（使用模糊匹配）
    let matchedLabel: LabelMapping | undefined;

    for (const label of allLabels) {
      if (isFieldMatch(fieldName, label.label)) {
        matchedLabel = label;
        break;
      }
    }

    if (matchedLabel && matchedLabel.suggestedTarget) {
      // 匹配成功 → 生成映射记录
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
      // 匹配失败 → 记录到未匹配列表
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
 * 检查所有映射是否已完成（全部状态非 pending）
 *
 * 用于判断 TemplateFiller 是否需要继续执行。
 *
 * @param mappings 字段映射列表
 * @returns 是否全部完成
 */
export function allMappingsDone(mappings: FieldMapping[]): boolean {
  if (mappings.length === 0) return true;
  return mappings.every((m) => m.status !== "pending");
}

/**
 * 获取映射完成统计
 *
 * 用于日志记录和前端展示进度。
 *
 * @param mappings 字段映射列表
 * @returns 各状态的统计数
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
