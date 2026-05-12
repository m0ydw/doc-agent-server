/**
 * DataExtractor — 双阶段结构化数据提取器
 *
 * 从用户的自由文本输入中提取结构化字段数据（如姓名=张三、电话=139...）。
 *
 * 【设计动机】
 * 用户输入通常是非结构化的（"帮我填表：姓名张三，电话13912345678"），
 * 而 TemplateFiller 需要结构化的键值对才能执行写入。
 * DataExtractor 桥接了"自由文本 → 结构化数据"的鸿沟。
 *
 * 【双阶段设计】
 * 阶段一：确定性正则匹配，快速提取 90% 的明确信息（电话、邮箱、键值对）
 * 阶段二：LLM 兜底提取，处理格式自由的描述文本（覆盖正则遗漏的字段）
 *
 * 【合并策略】确定性优先，LLM 补充未覆盖的字段（确定性结果直接保留，不被 LLM 覆盖）
 *
 * 【在整体流程中的位置】
 * 由 orchestrator 节点在 detect taskType === "complex_fill" 时调用，
 * 提取结果存入 AgentState.extractedData，后续由 templateMapper 使用。
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ================================================================
// 类型定义
// ================================================================

/** 提取结果 */
export interface ExtractionResult {
  /** 提取到的键值对（字段名 → 字段值） */
  data: Record<string, string>;
  /** 覆盖率（0~1）：提取到的字段占已知字段列表的比例 */
  coverage: number;
  /** 提取方法：deterministic（纯正则）/ llm（纯LLM）/ hybrid（混合） */
  method: "deterministic" | "llm" | "hybrid";
}

// ================================================================
// 阶段一：确定性正则提取
//
// 快速提取用户输入中明确格式的数据：键值对、手机号、邮箱。
// 无需 LLM 参与，速度快且准确。
// ================================================================

/**
 * 常见字段别名映射（用户输入中可能出现的变体）
 *
 * 例如用户输入中的"手机"、"联系电话"、"号码"都会被映射为标准字段名"电话"。
 * 这解决了用户输入用词不统一的问题。
 */
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
 * 阶段一：从用户输入中通过正则提取明确的键值对
 *
 * 匹配三种模式：
 * 1. 标准键值对 "字段名[：:=]\s*值"（值到逗号、分号、句号或结尾）
 * 2. 11位中国大陆手机号（1[3-9]\d{9}）
 * 3. 电子邮箱地址
 *
 * @param input 用户原始输入文本
 * @returns 提取到的键值对（字段名已标准化）
 */
export function extractDeterministic(input: string): Record<string, string> {
  const result: Record<string, string> = {};

  // 模式1：标准键值对 "字段名[：:=]\s*值"（值到逗号、分号、句号或结尾）
  const kvPattern = /([^\s，,;；\n]+)[：:=]\s*(.+?)(?=\s*(?:[，,;；]|$))/g;
  let match: RegExpExecArray | null;
  while ((match = kvPattern.exec(input)) !== null) {
    const rawKey = match[1].trim();
    const rawValue = match[2].trim();
    // 限制键长（<20字符）和值长（<200字符），过滤误匹配
    if (rawKey && rawValue && rawKey.length < 20 && rawValue.length < 200) {
      const canonicalKey = resolveFieldName(rawKey);
      // 已有相同字段值时保留第一个（确定性提取不覆盖）
      if (!result[canonicalKey]) {
        result[canonicalKey] = rawValue;
      }
    }
  }

  // 模式2：电话号码（11位手机号）
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

  // 清理：去掉值中可能残留的尾随标点
  for (const key of Object.keys(result)) {
    result[key] = result[key].replace(/[，,;；。、]$/, "").trim();
  }

  return result;
}

/**
 * 将用户输入的字段名解析为标准字段名
 *
 * 匹配优先级：
 * 1. 直接匹配（原始键等于标准名或存在于别名表中）
 * 2. 模糊匹配（原始键包含某个别名或反之）
 * 3. 无匹配时返回原始键（作为新字段保留）
 *
 * @param rawKey 用户输入中的原始字段名
 * @returns 标准化后的字段名
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
//
// 当确定性正则覆盖率不足时，调用 LLM 从自由文本中提取遗漏的字段。
// LLM 更适合处理格式不固定的描述文本（如"导师是张老师"这种非键值对描述）。
// ================================================================

/**
 * 使用 LLM 从自由文本中提取结构化字段（阶段二：兜底）
 *
 * 【调用条件】仅当确定性提取覆盖率不足时调用
 * 【输出格式要求】纯 JSON 对象（通过 System Prompt 中的规则约束）
 *
 * @param llm         LLM 实例
 * @param userInput   用户原始输入文本
 * @param knownFields 已知的字段名称列表（来自意图分类）
 * @returns 提取到的键值对
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

    // 安全提取 JSON（贪婪正则 + JSON.parse）
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
//
// 决策流程：
// 1. 始终执行阶段一（确定性正则，零成本）
// 2. 计算覆盖率 = 提取到的字段数 / 已知字段数
// 3. 覆盖率 >= 70% → 直接使用确定性结果（无需 LLM）
// 4. 覆盖率 < 70%  → 触发阶段二 LLM 补全缺失字段
// 5. 合并结果：确定性数据优先，LLM 补充未覆盖的字段
// ================================================================

/**
 * 双阶段数据提取主入口
 *
 * 【调用时机】orchestrator 节点检测到 taskType === "complex_fill" 时
 * 【输出】提取到的结构化数据存入 AgentState.extractedData
 *
 * @param llm         LLM 实例（用于阶段二兜底）
 * @param userInput   用户原始输入文本
 * @param knownFields 已知的字段名列表（从意图分类或字段配置中获得）
 * @returns ExtractionResult（data + coverage + method）
 */
export async function extractStructuredData(
  llm: ChatOpenAI,
  userInput: string,
  knownFields: string[] = [],
): Promise<ExtractionResult> {
  // 阶段一：确定性正则提取（始终执行）
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

  // 覆盖率 >= 70%：确定性结果足够好，直接返回（省去 LLM 调用开销）
  if (coverage >= 0.7) {
    return { data: detResult, coverage, method: "deterministic" };
  }

  // 覆盖率不足，触发阶段二 LLM 兜底
  // 找出尚未被确定性提取覆盖的字段（减少 LLM 需要处理的字段数）
  const canonicalDetFields = new Set(detFields);
  const missingFields = knownFields.filter((f) => !canonicalDetFields.has(f));

  const llmResult = await extractWithLLM(llm, userInput, missingFields);

  // 合并策略：确定性优先（detResult 直接保留），LLM 补充未覆盖的字段
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
    // hybrid = 有确定性也有 LLM，llm = 只有 LLM
    method: detFields.length > 0 ? "hybrid" : "llm",
  };
}
