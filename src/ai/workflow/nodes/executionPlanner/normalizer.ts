/**
 * ================================================================
 * 用户数据归一化器
 * ================================================================
 */

import type { NormalizedUserData, NormalizationResult } from "./types";

/** 字段别名映射 */
const FIELD_ALIASES: Record<string, string[]> = {
  "姓名": ["名字", "名称", "负责人", "主持人"],
  "电话": ["手机", "联系电话", "联系方式", "号码"],
  "邮箱": ["电子邮件", "email", "e-mail", "邮件"],
  "地址": ["住址", "联系地址", "通讯地址"],
  "日期": ["时间", "出生日期", "入职日期"],
  "金额": ["费用", "价格", "经费", "预算"],
  "编号": ["学号", "工号", "证件号", "身份证"],
  "学院": ["院系", "学校", "单位", "部门"],
  "专业": ["专业名称", "学科"],
  "班级": ["年级", "班级名称"],
  "标题": ["题目", "项目名称", "课题"],
  "描述": ["说明", "备注", "简介", "摘要"],
};

/**
 * 归一化用户数据
 */
export function normalizeUserData(
  extractedData: Record<string, unknown>
): NormalizationResult {
  const normalized: NormalizedUserData = {};
  let matchCount = 0;

  for (const [key, value] of Object.entries(extractedData)) {
    const stringValue = stringifyScalarValue(value);
    if (!stringValue) continue;

    // 查找别名
    const aliases = findAliases(key);

    normalized[key] = {
      value: stringValue,
      aliases,
      semanticType: inferSemanticType(key),
    };

    matchCount++;
  }

  return {
    normalized,
    matchCount,
    totalCount: Object.keys(extractedData).length,
  };
}

function stringifyScalarValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * 查找字段别名
 */
function findAliases(fieldName: string): string[] {
  const lowerFieldName = fieldName.toLowerCase();

  // 直接匹配
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    if (key === fieldName || aliases.includes(fieldName)) {
      return [key, ...aliases];
    }
  }

  // 模糊匹配
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    if (
      key.toLowerCase().includes(lowerFieldName) ||
      lowerFieldName.includes(key.toLowerCase()) ||
      aliases.some(a => a.toLowerCase().includes(lowerFieldName) || lowerFieldName.includes(a.toLowerCase()))
    ) {
      return [key, ...aliases];
    }
  }

  return [fieldName];
}

/**
 * 推断语义类型
 */
function inferSemanticType(fieldName: string): string {
  const lowerFieldName = fieldName.toLowerCase();

  if (/电话|手机|联系方式|phone|tel/i.test(lowerFieldName)) return "phone";
  if (/邮箱|邮件|email/i.test(lowerFieldName)) return "email";
  if (/地址|住址|address/i.test(lowerFieldName)) return "address";
  if (/姓名|名字|name/i.test(lowerFieldName)) return "name";
  if (/日期|时间|date|time/i.test(lowerFieldName)) return "date";
  if (/金额|费用|price|amount/i.test(lowerFieldName)) return "amount";
  if (/编号|学号|工号|id/i.test(lowerFieldName)) return "id";

  return "unknown";
}
