const fs = require("fs");
const path = require("path");
const { DOCS_DIR, runCommand, runQuery } = require("../cliRunner");
const sessionManager = require("../session");

/**
 * 查找文本在文档中的位置
 * @param {string} docId - 文档 ID
 * @param {string} pattern - 查找模式
 * @returns {Promise<array>} - 匹配位置数组
 */
async function findText(docId, pattern) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    const sessionId = await sessionManager.createOrUseSession(docId);

    const selectJson = JSON.stringify({
      type: "text",
      pattern: pattern,
    });

    const output = await runQuery([
      "query",
      "match",
      "--select-json",
      selectJson,
      "--require",
      "any",
      "--output",
      "json",
      "--session",
      sessionId,
    ]);

    const data = JSON.parse(output);
    if (!data.ok || !data.data?.items || data.data.items.length === 0) {
      return [];
    }

    return data.data.items.map((item, index) => ({
      index,
      text: item.text || item.content || item.handle?.text || "",
      ref: item.handle?.ref || "",
      evaluatedRevision: data.data.evaluatedRevision,
    }));
  } catch (e) {
    console.error("[Editor] 查找失败:", e.message);
    return [];
  }
}

/**
 * 替换第一个匹配的文本
 * @param {string} docId - 文档 ID
 * @param {string} targetText - 要替换的文本
 * @param {string} replacement - 替换文本
 * @returns {Promise<object>}
 */
async function replaceFirst(docId, targetText, replacement) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    const sessionId = await sessionManager.createOrUseSession(docId);

    const selectJson = JSON.stringify({
      type: "text",
      pattern: targetText,
    });

    const matchOutput = await runQuery([
      "query",
      "match",
      "--select-json",
      selectJson,
      "--require",
      "first",
      "--output",
      "json",
      "--session",
      sessionId,
    ]);

    const matchData = JSON.parse(matchOutput);
    if (!matchData.ok || !matchData.data?.items || matchData.data.items.length === 0) {
      throw new Error("未找到匹配内容");
    }

    const ref = matchData.data.items[0]?.handle?.ref;
    if (!ref) {
      throw new Error("无法获取替换位置");
    }

    const mutations = JSON.stringify([
      {
        id: "replace-1",
        op: "text.rewrite",
        where: { by: "ref", ref: ref },
        args: { replacement: { text: replacement } },
      },
    ]);

    await runQuery([
      "mutations",
      "apply",
      "--mutations",
      mutations,
      "--session",
      sessionId,
    ]);

    return { success: true, replaced: 1 };
  } catch (e) {
    console.error("[Editor] 替换失败:", e.message);
    return { success: false, message: e.message };
  }
}

/**
 * 替换所有匹配的文本
 * @param {string} docId - 文档 ID
 * @param {string} targetText - 要替换的文本
 * @param {string} replacement - 替换文本
 * @returns {Promise<object>}
 */
async function replaceAll(docId, targetText, replacement) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    const sessionId = await sessionManager.createOrUseSession(docId);

    const selectJson = JSON.stringify({
      type: "text",
      pattern: targetText,
    });

    const matchOutput = await runQuery([
      "query",
      "match",
      "--select-json",
      selectJson,
      "--require",
      "any",
      "--output",
      "json",
      "--session",
      sessionId,
    ]);

    const matchData = JSON.parse(matchOutput);
    if (!matchData.ok || !matchData.data?.items || matchData.data.items.length === 0) {
      return { success: true, replaced: 0 };
    }

    const items = matchData.data.items;

    const mutations = items
      .map((item, index) => {
        const ref = item?.handle?.ref;
        if (!ref) return null;
        return {
          id: `replace-${index}`,
          op: "text.rewrite",
          where: { by: "ref", ref: ref },
          args: { replacement: { text: replacement } },
        };
      })
      .filter(Boolean);

    if (mutations.length === 0) {
      return { success: true, replaced: 0 };
    }

    await runQuery([
      "mutations",
      "apply",
      "--mutations",
      JSON.stringify(mutations),
      "--session",
      sessionId,
    ]);

    return { success: true, replaced: mutations.length };
  } catch (e) {
    console.error("[Editor] 替换失败:", e.message);
    return { success: false, message: e.message };
  }
}

/**
 * 获取文档纯文本
 * @param {string} docId - 文档 ID
 * @returns {Promise<string>}
 */
async function getText(docId) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    const sessionId = await sessionManager.createOrUseSession(docId);

    const output = await runCommand(["get-text", "--session", sessionId]);
    return output.trim();
  } catch (e) {
    throw new Error("获取文本失败: " + e.message);
  }
}

/**
 * 获取文档信息
 * @param {string} docId - 文档 ID
 * @returns {Promise<object>}
 */
async function getInfo(docId) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    const sessionId = await sessionManager.createOrUseSession(docId);

    const output = await runCommand(["info", "--session", sessionId]);
    return JSON.parse(output);
  } catch (e) {
    throw new Error("获取信息失败: " + e.message);
  }
}

/**
 * 插入文本（预留接口）
 * @param {string} docId - 文档 ID
 * @param {string} text - 插入的文本
 * @param {string} position - 位置
 * @returns {Promise<object>}
 */
async function insertText(docId, text, position = "end") {
  // TODO: 实现插入文本逻辑
  return { success: false, message: "预留接口" };
}

/**
 * 删除文本（预留接口）
 * @param {string} docId - 文档 ID
 * @param {string} start - 起始位置
 * @param {string} end - 结束位置
 * @returns {Promise<object>}
 */
async function deleteText(docId, start, end) {
  // TODO: 实现删除文本逻辑
  return { success: false, message: "预留接口" };
}

module.exports = {
  findText,
  replaceFirst,
  replaceAll,
  getText,
  getInfo,
  insertText,
  deleteText,
};