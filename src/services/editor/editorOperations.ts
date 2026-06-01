/**
 * ============================================================
 * 【编辑操作 - editorOperations.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是文档编辑操作的核心模块，负责：
 * 1. 文本查找（findText）
 * 2. 文本替换（replaceFirst、replaceAll）
 * 3. 纯文本获取（getTextContent）
 * 4. 文档信息获取（getDocumentInfo）
 * 
 * 【架构位置】
 * docOperationsRoutes.ts → 【editorOperations】 → sessionManager → cliRunner → SDK
 * 
 * 【数据流】
 * 路由调用findText(docId, pattern)
 *   ↓
 * getDocumentSession()获取文档句柄
 *   ↓
 * doc.query.match()查找文本
 *   ↓
 * 返回匹配结果
 * 
 * 【SDK调用方式】
 * - doc.query.match: 查找文本
 * - doc.mutations.apply: 执行变更
 * - doc.getText: 获取纯文本
 * - doc.info: 获取文档信息
 * 
 * 【使用的模块】
 * sessionManager: 会话管理器
 *   - createOrUseSession: 创建或使用会话
 * 
 * formatOperations: 格式操作
 *   - setText: 设置文本
 *   - MutationApplyOptions: 变更应用选项
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【会话管理器】
// 管理SuperDoc SDK的会话
import * as sessionManager from "../session";

// 【格式操作】
// 文本设置和变更应用
import { setText, type MutationApplyOptions } from "./formatOperations";

// ================================================================
// 【辅助函数】
// ================================================================

/**
 * 【获取文档会话】
 * 
 * 【功能说明】
 * 通过会话管理器获取SDK文档句柄
 * 内部helper，供所有编辑操作复用
 * 
 * 【执行流程】
 * 1. 调用sessionManager.createOrUseSession()
 * 2. 返回文档句柄
 * 
 * @param docId - 文档ID
 * @returns 文档句柄
 */
async function getDocumentSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}

// ================================================================
// 【类型定义】
// ================================================================

/**
 * 【匹配项类型】
 * 
 * 【功能说明】
 * 文本匹配结果的结构
 * 
 * 【字段说明】
 * @property index - 匹配项的索引
 * @property text - 匹配的文本内容
 * @property ref - SDK内部引用标识，用于后续的编辑操作定位
 * @property evaluatedRevision - 匹配时的文档修订版本号
 */
export interface MatchItem {
  index: number;
  text: string;
  ref: string;
  evaluatedRevision: number;
}

/**
 * 【引用替换类型】
 * 
 * 【功能说明】
 * 基于引用的替换操作参数
 * 
 * 【字段说明】
 * @property ref - SDK内部引用标识
 * @property text - 替换后的文本
 * @property oldText - 原始文本（可选）
 * @property reason - 替换原因（可选）
 */
export interface RefReplacement {
  ref: string;
  text: string;
  oldText?: string;
  reason?: string;
}

// ================================================================
// 【编辑操作函数】
// ================================================================

/**
 * 【查找文本】
 * 
 * 【功能说明】
 * 在文档中搜索指定文本的所有匹配
 * 调用SDK doc.query.match进行全文搜索
 * 
 * 【SDK调用】
 * doc.query.match({
 *   select: { type: "text", pattern: "查找文本" },
 *   require: "any"  // 返回全部匹配
 * })
 * 
 * 【执行流程】
 * 1. 获取文档会话
 * 2. 调用doc.query.match()查找文本
 * 3. 处理匹配结果
 * 4. 返回MatchItem数组
 * 
 * @param docId - 文档ID
 * @param pattern - 要查找的文本模式
 * @returns 匹配结果数组
 */
export async function findText(docId: string, pattern: string): Promise<MatchItem[]> {
  console.log("查询内容" + pattern);
  try {
    // 【获取文档会话】
    const doc: any = await getDocumentSession(docId);
    
    // 【调用SDK查找文本】
    const result: any = await doc.query.match({
      select: { type: "text", pattern: pattern },
      require: "any"
    });
    
    // 【检查结果】
    if (!result.items || result.items.length === 0) {
      console.log("[Editor] 查询文本: " + pattern + " - 未找到匹配");
      return [];
    }
    
    console.log("[Editor] 查询文本: " + pattern + " - 找到 " + result.items.length + " 个匹配");
    
    // 【处理匹配结果】
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

/**
 * 【替换第一个匹配】
 * 
 * 【功能说明】
 * 替换文档中第一个匹配的文本
 * 
 * 【执行流程】
 * 1. 获取文档会话
 * 2. 调用doc.query.match()查找第一个匹配
 * 3. 获取ref引用
 * 4. 调用setText()执行替换
 * 5. 返回替换结果
 * 
 * 【SDK调用】
 * doc.query.match({
 *   select: { type: "text", pattern: "目标文本" },
 *   require: "first"  // 只返回第一个匹配
 * })
 * 
 * @param docId - 文档ID
 * @param targetText - 要替换的目标文本
 * @param replacement - 替换后的文本
 * @returns 替换结果
 */
export async function replaceFirst(docId: string, targetText: string, replacement: string): Promise<any> {
  try {
    // 【获取文档会话】
    const doc: any = await getDocumentSession(docId);
    
    // 【查找第一个匹配】
    const matchResult: any = await doc.query.match({
      select: { type: "text", pattern: targetText },
      require: "first"
    });
    
    // 【检查结果】
    if (!matchResult.items || matchResult.items.length === 0) {
      throw new Error("未找到匹配内容");
    }
    
    // 【获取ref引用】
    const refValue = matchResult.items[0].handle ? matchResult.items[0].handle.ref : null;
    if (!refValue) {
      throw new Error("无法获取替换位置");
    }
    
    // 【执行替换】
    await setText(docId, refValue, replacement);
    console.log("[Editor] 替换第一个: " + targetText + " -> " + replacement + " - 成功");
    return { success: true, replaced: 1 };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "未知错误";
    console.error("[Editor] 替换失败:", msg);
    return { success: false, message: msg };
  }
}

/**
 * 【替换所有匹配】
 * 
 * 【功能说明】
 * 替换文档中所有匹配的文本
 * 
 * 【执行流程】
 * 1. 获取文档会话
 * 2. 调用doc.query.match()查找所有匹配
 * 3. 构造替换数组
 * 4. 调用replaceByRefs()批量替换
 * 5. 返回替换结果
 * 
 * 【与replaceFirst的区别】
 * - require: "any" 获取全部匹配
 * - 批量构造mutations
 * - atomic: true 表示所有替换作为一个原子操作执行
 * 
 * @param docId - 文档ID
 * @param targetText - 要替换的目标文本
 * @param replacement - 替换后的文本
 * @returns 替换结果
 */
export async function replaceAll(docId: string, targetText: string, replacement: string): Promise<any> {
  try {
    // 【获取文档会话】
    const doc: any = await getDocumentSession(docId);
    
    // 【查找所有匹配】
    const matchResult: any = await doc.query.match({
      select: { type: "text", pattern: targetText },
      require: "any"
    });
    
    // 【检查结果】
    if (!matchResult.items || matchResult.items.length === 0) {
      return { success: true, replaced: 0 };
    }
    
    // 【构造替换数组】
    const items = matchResult.items;
    const replacements: RefReplacement[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const ref = item.handle ? item.handle.ref : null;
      if (!ref) continue;
      replacements.push({ ref, text: replacement });
    }
    
    // 【检查是否有可替换的项】
    if (replacements.length === 0) {
      return { success: true, replaced: 0 };
    }
    
    // 【批量替换】
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

/**
 * 【根据引用批量替换】
 * 
 * 【功能说明】
 * 根据ref引用批量替换文本
 * 
 * 【执行流程】
 * 1. 遍历替换数组
 * 2. 对每个替换调用setText()
 * 3. 收集替换结果
 * 4. 返回结果数组
 * 
 * @param docId - 文档ID
 * @param replacements - 替换数组
 * @param options - 变更应用选项
 * @returns 替换结果数组
 */
export async function replaceByRefs(
  docId: string,
  replacements: RefReplacement[],
  options?: MutationApplyOptions,
): Promise<Array<RefReplacement & { success: boolean; error?: string }>> {
  // 【检查替换数组】
  if (!replacements.length) return [];

  const results: Array<RefReplacement & { success: boolean; error?: string }> = [];

  // 【遍历替换】
  for (const replacement of replacements) {
    try {
      // 【执行替换】
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

/**
 * 【获取纯文本内容】
 * 
 * 【功能说明】
 * 获取文档的完整纯文本内容
 * 调用SDK doc.getText()，返回不含格式信息的纯文本
 * 
 * 【使用场景】
 * - AI分析
 * - 全文搜索
 * - 需要纯文本的场景
 * 
 * @param docId - 文档ID
 * @returns 纯文本内容
 */
export async function getTextContent(docId: string): Promise<string> {
  try {
    // 【获取文档会话】
    const doc = await getDocumentSession(docId);
    
    // 【获取纯文本】
    const text = await doc.getText();
    console.log("[Editor] 获取文本: " + docId + " - 成功 (" + text.length + " 字符)");
    return text;
  } catch (e: unknown) {
    throw new Error("获取文本失败: " + (e instanceof Error ? e.message : "未知错误"));
  }
}

/**
 * 【获取文档信息】
 * 
 * 【功能说明】
 * 获取文档的结构化信息
 * 调用SDK doc.info()，返回文档元数据
 * 
 * 【返回信息】
 * - 页数
 * - 段落数
 * - 表格数
 * - 等等
 * 
 * 【使用场景】
 * AI Agent在分析阶段快速了解文档结构
 * 
 * @param docId - 文档ID
 * @returns 文档信息
 */
export async function getDocumentInfo(docId: string): Promise<any> {
  try {
    // 【获取文档会话】
    const doc = await getDocumentSession(docId);
    
    // 【获取文档信息】
    const info = await doc.info();
    console.log("[Editor] 获取文档信息: " + docId + " - 成功");
    return info;
  } catch (e: unknown) {
    throw new Error("获取信息失败: " + (e instanceof Error ? e.message : "未知错误"));
  }
}
