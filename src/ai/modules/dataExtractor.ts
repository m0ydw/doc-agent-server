/**
 * DataExtractor — 双阶段结构化数据提取器
 *
 * 阶段一：确定性正则匹配，快速提取 90% 的明确信息（电话、邮箱、键值对）
 * 阶段二：LLM 兜底提取，处理格式自由的描述文本
 *
 * 合并策略：确定性优先，LLM 补充未覆盖的字段
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ================================================================
// 类型
// ================================================================

export interface ExtractionResult {
  data: Record<string, string>;
  coverage: number; // 0~1
  method: "deterministic" | "llm" | "hybrid";
}

// ================================================================
// 阶段一：确定性正则提取
// ================================================================

/** 常见字段别名映射（用户输入中可能出现的变体） */
const FIELD_ALIASES: Record<string, string[]> = {
  "项目名称": ["项目名", "课题名称", "课题名", "项目标题", "标题"],
  "负责人": ["主持人", "项目负责人", "组长", "责任人", "姓名"],
  "指导教师": ["导师", "指导老师", "老师"],
  "团队成员": ["成员", "组员", "队伍", "团队"],
  "电话": ["手机", "手机号", "联系电话", "联系方式", "号码"],
  "邮箱": ["电子邮件", "email", "E-mail", "邮件"],
  "学号": ["学生号", "编号"],
  "班级": ["年级", "班级名称"],
  "学院": ["院系", "系别"],
  "专业": ["专业名称"],
};

/**
 * 从用户输入中通过正则提取明确的键值对
 */
export function extractDeterministic(input: string): Record<string, string> {
  const result: Record<string, string> = {};

  // 模式1：标准键值对 "字段名[：:=]\s*值"（值到逗号、分号、句号或结尾）
  const kvPattern = /([^\s，,;；\n]+)[：:=]\s*(.+?)(?=\s*(?:[，,;；]|$))/g;
  let match: RegExpExecArray | null;
  while ((match = kvPattern.exec(input)) !== null) {
    const rawKey = match[1].trim();
    const rawValue = match[2].trim();
    if (rawKey && rawValue && rawKey.length < 20 && rawValue.length < 200) {
      const canonicalKey = resolveFieldName(rawKey);
      if (!result[canonicalKey]) {
        result[canonicalKey] = rawValue;
      }
    }
  }

  // 模式2：电话号码
  const phonePattern = /1[3-9]\d{9}/g;
  let phoneMatch: RegExpExecArray | null;
  while ((phoneMatch = phonePattern.exec(input)) !== null) {
    if (!result["电话"]) {
      result["电话"] = phoneMatch[0];
    }
  }

  // 模式3：邮箱
  const emailPattern = /[\w.\-+]+@[\w.\-]+\.\w{2,}/g;
  let emailMatch: RegExpExecArray | null;
  while ((emailMatch = emailPattern.exec(input)) !== null) {
    if (!result["邮箱"]) {
      result["邮箱"] = emailMatch[0];
    }
  }

  // 清理：去掉值中可能残留的标点
  for (const key of Object.keys(result)) {
    result[key] = result[key].replace(/[，,;；。、]$/, "").trim();
  }

  return result;
}

/**
 * 将用户输入的字段名解析为标准字段名
 */
function resolveFieldName(rawKey: string): string {
  // 直接匹配别名表
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (canonical === rawKey || aliases.includes(rawKey)) {
      return canonical;
    }
  }
  // 模糊匹配：原始键包含在别名中
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (rawKey.includes(alias) || alias.includes(rawKey)) {
        return canonical;
      }
    }
  }
  // 无匹配，返回原始键
  return rawKey;
}

// ================================================================
// 阶段二：LLM 兜底提取
// ================================================================

/**
 * 使用 LLM 从自由文本中提取结构化字段
 * 仅当确定性提取覆盖率不足时调用
 */
export async function extractWithLLM(
  llm: ChatOpenAI,
  userInput: string,
  knownFields: string[],
): Promise<Record<string, string>> {
  const fieldList = knownFields.length > 0
    ? knownFields.join("、")
    : "项目名称、负责人、指导教师、团队成员、电话、邮箱、学号、班级、学院、专业";

  const systemPrompt = `你是数据提取专家。从用户文本中提取字段，输出纯 JSON。
【可提取字段列表】：${fieldList}
【规则】
- 只提取文本中明确提及的字段，未提及的字段值为空字符串 ""
- 不要编造、猜测、修改任何数据
- 输出纯 JSON 对象，不要包含任何解释文字`;

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`请从以下文本中提取结构化数据：\n\n${userInput}`),
  ];

  try {
    const response = await llm.invoke(messages);

    const content = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

    // 安全提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    }
  } catch (err) {
    console.warn("[DataExtractor] LLM 提取失败:", (err as Error).message);
  }

  return {};
}

// ================================================================
// 主入口：双阶段提取
// ================================================================

/**
 * 双阶段数据提取
 * @param llm - LLM 实例（用于阶段二兜底）
 * @param userInput - 用户原始输入
 * @param knownFields - 已知的字段名列表（从意图分类中获得）
 */
export async function extractStructuredData(
  llm: ChatOpenAI,
  userInput: string,
  knownFields: string[] = [],
): Promise<ExtractionResult> {
  // 阶段一：确定性正则提取
  const detResult = extractDeterministic(userInput);
  const detFields = Object.keys(detResult).filter((k) => detResult[k].trim());

  // 如果已知字段列表为空，直接返回确定性结果
  if (knownFields.length === 0) {
    if (detFields.length > 0) {
      return { data: detResult, coverage: 1, method: "deterministic" };
    }
    // 没有已知字段也没有提取到任何数据，尝试 LLM
    const llmResult = await extractWithLLM(llm, userInput, []);
    const combined = { ...detResult, ...llmResult };
    return {
      data: combined,
      coverage: Object.keys(combined).filter((k) => combined[k].trim()).length > 0 ? 1 : 0,
      method: "llm",
    };
  }

  // 覆盖率计算
  const coverage = detFields.length / knownFields.length;

  if (coverage >= 0.7) {
    // 确定性提取覆盖率 ≥ 70%，直接使用
    return { data: detResult, coverage, method: "deterministic" };
  }

  // 覆盖率不足，触发阶段二 LLM 兜底
  // 找出尚未被确定性提取覆盖的字段
  const canonicalDetFields = new Set(detFields);
  const missingFields = knownFields.filter((f) => !canonicalDetFields.has(f));

  const llmResult = await extractWithLLM(llm, userInput, missingFields);

  // 合并：确定性优先，LLM 补充
  const combined: Record<string, string> = { ...detResult };
  for (const [key, value] of Object.entries(llmResult)) {
    if (value && value.trim() && !combined[key]) {
      const canonicalKey = resolveFieldName(key);
      if (!combined[canonicalKey]) {
        combined[canonicalKey] = value;
      }
    }
  }

  const finalFields = Object.keys(combined).filter((k) => combined[k].trim());
  const finalCoverage = knownFields.length > 0
    ? Math.min(1, finalFields.length / knownFields.length)
    : 1;

  return {
    data: combined,
    coverage: finalCoverage,
    method: detFields.length > 0 ? "hybrid" : "llm",
  };
}
