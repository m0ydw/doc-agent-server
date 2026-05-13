/**
 * ================================================================
 * Structured Output 封装（兼容 DeepSeek）
 * ================================================================
 *
 * 封装 LLM 调用，使用 JSON mode + Zod 验证实现结构化输出。
 * 不依赖 llm.withStructuredOutput()，兼容 DeepSeek 等模型。
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

/** Structured Output 结果 */
export interface StructuredOutputResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  rawOutput?: string;
}

/**
 * 调用 LLM 并返回结构化输出
 *
 * @param llm LLM 实例
 * @param schema Zod schema
 * @param systemPrompt System prompt
 * @param humanPrompt Human prompt
 * @returns 结构化输出结果
 */
export async function invokeWithStructuredOutput<T>(
  llm: ChatOpenAI,
  schema: z.ZodSchema<T>,
  systemPrompt: string,
  humanPrompt: string
): Promise<T> {
  // 构建提示词，要求输出 JSON
  const jsonInstruction = `
【输出要求】
你必须输出一个有效的 JSON 对象，符合以下 schema：
${JSON.stringify(zodSchemaToJsonSchema(schema), null, 2)}

不要输出任何其他内容，只输出 JSON。`;

  const fullSystemPrompt = `${systemPrompt}\n${jsonInstruction}`;

  // 调用 LLM
  const response = await llm.invoke([
    new SystemMessage(fullSystemPrompt),
    new HumanMessage(humanPrompt),
  ]);

  const content = typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);

  // 提取 JSON
  const jsonStr = extractJson(content);

  // 解析 JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse JSON from LLM output: ${(err as Error).message}\nRaw output: ${content}`);
  }

  // 验证 schema
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Schema validation failed: ${result.error.message}\nParsed data: ${JSON.stringify(parsed)}`);
  }

  return result.data;
}

/**
 * 从 LLM 输出中提取 JSON 字符串
 */
function extractJson(content: string): string {
  const trimmed = content.trim();

  // 策略1: 整个内容就是 JSON
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }

  // 策略2: 从 markdown code block 中提取
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // 策略3: 从花括号中提取
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return braceMatch[0];
  }

  // 策略4: 从方括号中提取
  const bracketMatch = trimmed.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    return bracketMatch[0];
  }

  throw new Error(`No JSON found in LLM output: ${content.slice(0, 200)}`);
}

/**
 * 将 Zod schema 转换为简化的 JSON schema（用于提示词）
 */
function zodSchemaToJsonSchema(schema: any): unknown {
  // 处理 ZodObject
  if (schema?._def?.typeName === 'ZodObject' || schema?.constructor?.name === 'ZodObject') {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodTypeToJsonSchemaType(value as any);
      if (!(value as any).isOptional?.()) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  return { type: "object" };
}

/**
 * 将 Zod 类型转换为 JSON schema 类型描述
 */
function zodTypeToJsonSchemaType(schema: any): unknown {
  const typeName = schema?._def?.typeName || schema?.constructor?.name;

  if (typeName === 'ZodString') {
    return { type: "string" };
  }
  if (typeName === 'ZodNumber') {
    return { type: "number" };
  }
  if (typeName === 'ZodBoolean') {
    return { type: "boolean" };
  }
  if (typeName === 'ZodArray') {
    return { type: "array", items: zodTypeToJsonSchemaType(schema.element) };
  }
  if (typeName === 'ZodObject') {
    return zodSchemaToJsonSchema(schema);
  }
  if (typeName === 'ZodEnum') {
    return { type: "string", enum: schema.options || schema._def?.values };
  }
  if (typeName === 'ZodOptional') {
    return zodTypeToJsonSchemaType(schema.unwrap?.() || schema._def?.innerType);
  }
  if (typeName === 'ZodNullable') {
    return zodTypeToJsonSchemaType(schema.unwrap?.() || schema._def?.innerType);
  }
  if (typeName === 'ZodUnion') {
    const options = schema.options || schema._def?.options || [];
    return { oneOf: options.map((opt: any) => zodTypeToJsonSchemaType(opt)) };
  }

  return { type: "any" };
}

/**
 * 批量调用 LLM 并返回结构化输出（并发控制）
 */
export async function invokeBatchWithStructuredOutput<T>(
  llm: ChatOpenAI,
  schema: z.ZodSchema<T>,
  systemPrompt: string,
  humanPrompts: string[],
  concurrency: number = 3
): Promise<StructuredOutputResult<T>[]> {
  const results: StructuredOutputResult<T>[] = [];

  // 简单的并发控制
  for (let i = 0; i < humanPrompts.length; i += concurrency) {
    const batch = humanPrompts.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (prompt) => {
        try {
          const data = await invokeWithStructuredOutput(llm, schema, systemPrompt, prompt);
          return { success: true, data };
        } catch (err) {
          return {
            success: false,
            error: (err as Error).message,
            rawOutput: "",
          };
        }
      })
    );
    results.push(...batchResults);
  }

  return results;
}
