import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export type StructuredValue = string | number | boolean | null | StructuredValue[] | { [key: string]: StructuredValue };

export interface ExtractionResult {
  data: Record<string, StructuredValue>;
  coverage: number;
  method: "deterministic" | "llm" | "hybrid";
}

const FIELD_ALIASES: Record<string, string[]> = {
  "项目名称": ["课题名称", "项目标题", "标题"],
  "项目类型": ["项目类别", "类别"],
  "项目负责人": ["负责人", "主持人", "组长"],
  "申报日期": ["日期", "申请日期"],
  "申请人或申请团队": ["团队成员", "申请团队", "成员"],
  "指导教师": ["导师", "指导老师", "教师"],
  "联系电话": ["电话", "手机", "联系方式"],
  "电子邮箱": ["邮箱", "E-mail", "email"],
};

export function extractDeterministic(input: string): Record<string, StructuredValue> {
  const result: Record<string, StructuredValue> = {};
  const kvPattern = /([^\s:：;；\n]{2,30})[:：]\s*(.+?)(?=\n|[;；]|$)/g;
  let match: RegExpExecArray | null;

  while ((match = kvPattern.exec(input)) !== null) {
    const key = resolveFieldName(match[1].trim());
    const value = match[2].trim();
    if (key && value && !result[key]) {
      result[key] = value.replace(/[;；。]$/, "").trim();
    }
  }

  return result;
}

export async function extractWithLLM(
  llm: ChatOpenAI,
  userInput: string,
  knownFields: string[],
): Promise<Record<string, StructuredValue>> {
  const fieldList = knownFields.length > 0
    ? knownFields.join("、")
    : "项目名称、项目类型、项目负责人、申报日期、申请人或申请团队、指导教师";

  const systemPrompt = `你是 DOCX 表格填充系统的数据抽取器。只输出合法 JSON 对象，不要输出解释。

规则：
- 保留用户原始结构，不要把多行表格压缩成一个字符串。
- “申请人或申请团队”“指导教师”等多行数据必须输出为对象数组。
- 未出现的字段不要编造。
- 可以使用这些字段：${fieldList}
- 示例结构：
{
  "项目名称": "...",
  "项目类型": "...",
  "项目负责人": "...",
  "申报日期": "...",
  "申请人或申请团队": [
    {
      "角色": "主持人",
      "姓名": "...",
      "年级": "...",
      "学校": "...",
      "所在院系/专业": "...",
      "联系电话": "...",
      "E-mail": "..."
    }
  ],
  "指导教师": [
    {
      "姓名": "...",
      "年龄": "...",
      "研究方向": "...",
      "行政职务/专业技术职务": "...",
      "手机": "...",
      "电子邮箱": "..."
    }
  ]
}`;

  try {
    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userInput),
    ]);

    const content = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]);
    return sanitizeObject(parsed);
  } catch (err) {
    console.warn("[DataExtractor] LLM extraction failed:", (err as Error).message);
    return {};
  }
}

export async function extractStructuredData(
  llm: ChatOpenAI,
  userInput: string,
  knownFields: string[] = [],
): Promise<ExtractionResult> {
  const deterministic = extractDeterministic(userInput);
  const llmResult = await extractWithLLM(llm, userInput, knownFields);
  const combined = mergeStructuredData(deterministic, llmResult);
  const extractedCount = Object.values(combined).filter(hasContent).length;
  const total = knownFields.length || Math.max(1, extractedCount);

  return {
    data: combined,
    coverage: Math.min(1, extractedCount / total),
    method: Object.keys(deterministic).length > 0 && Object.keys(llmResult).length > 0
      ? "hybrid"
      : Object.keys(llmResult).length > 0 ? "llm" : "deterministic",
  };
}

function resolveFieldName(rawKey: string): string {
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (canonical === rawKey || aliases.includes(rawKey)) return canonical;
  }

  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (rawKey.includes(canonical) || aliases.some(alias => rawKey.includes(alias))) {
      return canonical;
    }
  }

  return rawKey;
}

function mergeStructuredData(
  deterministic: Record<string, StructuredValue>,
  llmResult: Record<string, StructuredValue>,
): Record<string, StructuredValue> {
  const combined: Record<string, StructuredValue> = { ...llmResult };
  for (const [key, value] of Object.entries(deterministic)) {
    if (!hasContent(combined[key])) combined[key] = value;
  }
  return combined;
}

function sanitizeObject(value: unknown): Record<string, StructuredValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Record<string, StructuredValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeValue(child);
    if (hasContent(sanitized)) result[resolveFieldName(key)] = sanitized;
  }
  return result;
}

function sanitizeValue(value: unknown): StructuredValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeValue).filter(hasContent);
  if (typeof value === "object") {
    const result: Record<string, StructuredValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeValue(child);
      if (hasContent(sanitized)) result[key] = sanitized;
    }
    return result;
  }
  return "";
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
