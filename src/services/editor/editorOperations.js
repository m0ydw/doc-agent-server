const sessionManager = require("../session");

async function getDocumentSession(docId) {
  const { doc } = await sessionManager.createOrUseSession(docId);
  return doc;
}

/**
 * 查找文本在文档中的位置
 * @param {string} docId - 文档 ID
 * @param {string} pattern - 查找模式
 * @returns {Promise<array>} - 匹配位置数组
 */
async function findText(docId, pattern) {
  console.log(`查询内容${pattern}`);
  try {
    const doc = await getDocumentSession(docId);

    const result = await doc.query.match({
      select: {
        type: "text",
        pattern: pattern,
      },
      require: "any",
    });

    // SDK 返回结构：无 ok 字段，直接通过 items 判断
    if (!result.items || result.items.length === 0) {
      console.log(`[Editor] 查询文本: "${pattern}" - 未找到匹配`);
      return [];
    }

    console.log(
      `[Editor] 查询文本: "${pattern}" - 找到 ${result.items.length} 个匹配`
    );

    return result.items.map((item, index) => ({
      index,
      text: item.text || item.content || item.handle?.text || "",
      ref: item.handle?.ref || "",
      evaluatedRevision: result.evaluatedRevision,
    }));
  } catch (e) {
    console.log("[Editor] 查找失败:", e.message);
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
  try {
    const doc = await getDocumentSession(docId);

    // 先查找匹配
    const matchResult = await doc.query.match({
      select: {
        type: "text",
        pattern: targetText,
      },
      require: "first",
    });

    // SDK 返回结构：无 ok 字段，直接通过 items 判断
    if (!matchResult.items || matchResult.items.length === 0) {
      throw new Error("未找到匹配内容");
    }

    const ref = matchResult.items[0]?.handle?.ref;
    if (!ref) {
      throw new Error("无法获取替换位置");
    }

    // 应用替换
    await doc.mutations.apply({
      expectedRevision: matchResult.evaluatedRevision,
      atomic: true,
      steps: [
        {
          id: "replace-1",
          op: "text.rewrite",
          where: { by: "ref", ref: ref },
          args: { replacement: { text: replacement } },
        },
      ],
    });

    console.log(
      `[Editor] 替换第一个: "${targetText}" → "${replacement}" - 成功`
    );
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
  try {
    const doc = await getDocumentSession(docId);

    // 先查找所有匹配
    const matchResult = await doc.query.match({
      select: {
        type: "text",
        pattern: targetText,
      },
      require: "any",
    });

    // SDK 返回结构：无 ok 字段，直接通过 items 判断
    if (!matchResult.items || matchResult.items.length === 0) {
      return { success: true, replaced: 0 };
    }

    const items = matchResult.items;

    // 构建变更列表
    const steps = items
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

    if (steps.length === 0) {
      return { success: true, replaced: 0 };
    }

    // 批量应用变更
    await doc.mutations.apply({
      expectedRevision: matchResult.evaluatedRevision,
      atomic: true,
      steps: steps,
    });

    console.log(
      `[Editor] 替换全部: "${targetText}" → "${replacement}" - 替换了 ${steps.length} 处`
    );
    return { success: true, replaced: steps.length };
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
async function getTextContent(docId) {
  try {
    const doc = await getDocumentSession(docId);
    const text = await doc.getText();
    console.log(`[Editor] 获取文本: ${docId} - 成功 (${text.length} 字符)`);
    return text;
  } catch (e) {
    throw new Error("获取文本失败: " + e.message);
  }
}

/**
 * 获取文档信息
 * @param {string} docId - 文档 ID
 * @returns {Promise<object>}
 */
async function getDocumentInfo(docId) {
  try {
    const doc = await getDocumentSession(docId);
    const info = await doc.info();
    console.log(`[Editor] 获取文档信息: ${docId} - 成功`);
    return info;
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
  getText: getTextContent,
  getInfo: getDocumentInfo,
  insertText,
  deleteText,
};
