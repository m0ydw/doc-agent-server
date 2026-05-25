// 编辑操作 — 对文档进行查找/替换/文本提取等操作
// 所有操作都通过会话管理器获取 SDK 文档句柄
// SDK 调用方式：使用 doc.query.match 查找、doc.mutations.apply 执行变更

import * as sessionManager from "../session";
import { setText, type MutationApplyOptions } from "./formatOperations";

// getDocumentSession — 通过会话管理器获取 SDK 文档句柄
// 内部 helper，供所有编辑操作复用
async function getDocumentSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}

// MatchItem — 文本匹配结果的结构
export interface MatchItem {
  index: number;
  text: string;
  ref: string;                    // SDK 内部引用标识，用于后续的编辑操作定位
  evaluatedRevision: number;      // 匹配时的文档修订版本号
}

export interface RefReplacement {
  ref: string;
  text: string;
  oldText?: string;
  reason?: string;
}

// findText — 在文档中搜索指定文本的所有匹配
// 调用 SDK doc.query.match 进行全文搜索，require:"any" 返回全部匹配
// 返回 MatchItem 数组，包含每个匹配的文本、ref（SDK 引用）、修订版本号
export async function findText(docId: string, pattern: string): Promise<MatchItem[]> {
  console.log("查询内容" + pattern);
  try {
    const doc: any = await getDocumentSession(docId);
    const result: any = await doc.query.match({ select: { type: "text", pattern: pattern }, require: "any" });
    if (!result.items || result.items.length === 0) {
      console.log("[Editor] 查询文本: " + pattern + " - 未找到匹配");
      return [];
    }
    console.log("[Editor] 查询文本: " + pattern + " - 找到 " + result.items.length + " 个匹配");
    const mapped: MatchItem[] = [];
    for (let i = 0; i < result.items.length; i++) {
      const item = result.items[i];
      mapped.push({
        index: i,
        text: item.text || item.content || (item.handle ? item.handle.text : ""),
        ref: item.handle ? item.handle.ref : "",
        evaluatedRevision: Number(result.evaluatedRevision || 0),
      });
    }
    return mapped;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "未知错误";
    console.log("[Editor] 查找失败:", msg);
    return [];
  }
}

// replaceFirst — 替换文档中第一个匹配的文本
// 流程：match 查找第一个匹配 → 获取 ref → mutations.apply 执行 text.rewrite
// 使用 by:"ref" 定位，利用 SDK 的 ref 引用机制精确替换
export async function replaceFirst(docId: string, targetText: string, replacement: string): Promise<any> {
  try {
    const doc: any = await getDocumentSession(docId);
    const matchResult: any = await doc.query.match({ select: { type: "text", pattern: targetText }, require: "first" });
    if (!matchResult.items || matchResult.items.length === 0) throw new Error("未找到匹配内容");
    const refValue = matchResult.items[0].handle ? matchResult.items[0].handle.ref : null;
    if (!refValue) throw new Error("无法获取替换位置");
    await setText(docId, refValue, replacement);
    console.log("[Editor] 替换第一个: " + targetText + " -> " + replacement + " - 成功");
    return { success: true, replaced: 1 };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "未知错误";
    console.error("[Editor] 替换失败:", msg);
    return { success: false, message: msg };
  }
}

// replaceAll — 替换文档中所有匹配的文本
// 与 replaceFirst 的区别：require:"any" 获取全部匹配，批量构造 mutations
// atomic: true 表示所有替换作为一个原子操作执行（要么全部成功，要么全部失败）
export async function replaceAll(docId: string, targetText: string, replacement: string): Promise<any> {
  try {
    const doc: any = await getDocumentSession(docId);
    const matchResult: any = await doc.query.match({ select: { type: "text", pattern: targetText }, require: "any" });
    if (!matchResult.items || matchResult.items.length === 0) return { success: true, replaced: 0 };
    const items = matchResult.items;
    const replacements: RefReplacement[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const ref = item.handle ? item.handle.ref : null;
      if (!ref) continue;
      replacements.push({ ref, text: replacement });
    }
    if (replacements.length === 0) return { success: true, replaced: 0 };
    const results = await replaceByRefs(docId, replacements);
    const replaced = results.filter((item) => item.success).length;
    console.log("[Editor] 替换全部: " + targetText + " -> " + replacement + " - 替换了 " + replaced + " 处");
    return { success: true, replaced };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "未知错误";
    console.error("[Editor] 替换失败:", msg);
    return { success: false, message: msg };
  }
}

export async function replaceByRefs(
  docId: string,
  replacements: RefReplacement[],
  options?: MutationApplyOptions,
): Promise<Array<RefReplacement & { success: boolean; error?: string }>> {
  if (!replacements.length) return [];

  const results: Array<RefReplacement & { success: boolean; error?: string }> = [];

  for (const replacement of replacements) {
    try {
      await setText(docId, replacement.ref, replacement.text, options);
      results.push({ ...replacement, success: true });
    } catch (error) {
      results.push({
        ...replacement,
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  }

  return results;
}

// getTextContent — 获取文档的完整纯文本内容
// 调用 SDK doc.getText()，返回不含格式信息的纯文本
// 用于 AI 分析、全文搜索等需要纯文本的场景
export async function getTextContent(docId: string): Promise<string> {
  try {
    const doc = await getDocumentSession(docId);
    const text = await doc.getText();
    console.log("[Editor] 获取文本: " + docId + " - 成功 (" + text.length + " 字符)");
    return text;
  } catch (e: unknown) {
    throw new Error("获取文本失败: " + (e instanceof Error ? e.message : "未知错误"));
  }
}

// getDocumentInfo — 获取文档的结构化信息
// 调用 SDK doc.info()，返回文档元数据（如页数、段落数、表格数等）
// 供 AI Agent 在分析阶段快速了解文档结构
export async function getDocumentInfo(docId: string): Promise<any> {
  try {
    const doc = await getDocumentSession(docId);
    const info = await doc.info();
    console.log("[Editor] 获取文档信息: " + docId + " - 成功");
    return info;
  } catch (e: unknown) {
    throw new Error("获取信息失败: " + (e instanceof Error ? e.message : "未知错误"));
  }
}
