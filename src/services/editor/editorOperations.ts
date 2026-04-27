import * as sessionManager from "../session";

async function getDocumentSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}

export interface MatchItem {
  index: number;
  text: string;
  ref: string;
  evaluatedRevision: number;
}

export async function findText(docId: string, pattern: string): Promise<MatchItem[]> {
  console.log("查询内容" + pattern);
  try {
    var doc = await getDocumentSession(docId);
    var result = await doc.query.match({ select: { type: "text", pattern: pattern }, require: "any" });
    if (!result.items || result.items.length === 0) {
      console.log("[Editor] 查询文本: " + pattern + " - 未找到匹配");
      return [];
    }
    console.log("[Editor] 查询文本: " + pattern + " - 找到 " + result.items.length + " 个匹配");
    var mapped = [];
    for (var i = 0; i < result.items.length; i++) {
      var item = result.items[i];
      mapped.push({
        index: i,
        text: item.text || item.content || (item.handle ? item.handle.text : ""),
        ref: item.handle ? item.handle.ref : "",
        evaluatedRevision: result.evaluatedRevision,
      });
    }
    return mapped;
  } catch (e) {
    console.log("[Editor] 查找失败:", e.message);
    return [];
  }
}

export async function replaceFirst(docId: string, targetText: string, replacement: string): Promise<any> {
  try {
    var doc = await getDocumentSession(docId);
    var matchResult = await doc.query.match({ select: { type: "text", pattern: targetText }, require: "first" });
    if (!matchResult.items || matchResult.items.length === 0) throw new Error("未找到匹配内容");
    var refValue = matchResult.items[0].handle ? matchResult.items[0].handle.ref : null;
    if (!refValue) throw new Error("无法获取替换位置");
    var stepsArray = [{ id: "replace-1", op: "text.rewrite", where: { by: "ref", ref: refValue }, args: { replacement: { text: replacement } }}];
    var applyParams = {
      atomic: true,
      steps: stepsArray,
    };
    await doc.mutations.apply(applyParams);
    console.log("[Editor] 替换第一个: " + targetText + " -> " + replacement + " - 成功");
    return { success: true, replaced: 1 };
  } catch (e) {
    console.error("[Editor] 替换失败:", e.message);
    return { success: false, message: e.message };
  }
}

export async function replaceAll(docId: string, targetText: string, replacement: string): Promise<any> {
  try {
    var doc = await getDocumentSession(docId);
    var matchResult = await doc.query.match({ select: { type: "text", pattern: targetText }, require: "any" });
    if (!matchResult.items || matchResult.items.length === 0) return { success: true, replaced: 0 };
    var items = matchResult.items;
    var stepsArray = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var ref = item.handle ? item.handle.ref : null;
      if (!ref) continue;
      stepsArray.push({ id: "replace-" + i, op: "text.rewrite", where: { by: "ref", ref: ref }, args: { replacement: { text: replacement } } });
    }
    if (stepsArray.length === 0) return { success: true, replaced: 0 };
    await doc.mutations.apply({ atomic: true, steps: stepsArray });
    console.log("[Editor] 替换全部: " + targetText + " -> " + replacement + " - 替换了 " + stepsArray.length + " 处");
    return { success: true, replaced: stepsArray.length };
  } catch (e) {
    console.error("[Editor] 替换失败:", e.message);
    return { success: false, message: e.message };
  }
}

export async function getTextContent(docId: string): Promise<string> {
  try {
    var doc = await getDocumentSession(docId);
    var text = await doc.getText();
    console.log("[Editor] 获取文本: " + docId + " - 成功 (" + text.length + " 字符)");
    return text;
  } catch (e) {
    throw new Error("获取文本失败: " + e.message);
  }
}

export async function getDocumentInfo(docId: string): Promise<any> {
  try {
    var doc = await getDocumentSession(docId);
    var info = await doc.info();
    console.log("[Editor] 获取文档信息: " + docId + " - 成功");
    return info;
  } catch (e) {
    throw new Error("获取信息失败: " + e.message);
  }
}