const path = require("path");

// 文档目录
const DOCS_DIR = path.join(__dirname, "../../uploads");

// SDK 客户端（单例）
let client = null;
let isConnected = false;

/**
 * 获取或创建 SDK 客户端
 * @returns {Promise<object>} - SDK 客户端
 */
async function getClient() {
  if (client && isConnected) {
    return client;
  }

  // 动态导入 ESM 模块
  const { createSuperDocClient } = await import('@superdoc-dev/sdk');
  
  client = createSuperDocClient();
  await client.connect();
  isConnected = true;
  
  console.log("[SDK] Client connected");
  return client;
}

/**
 * 关闭 SDK 客户端
 */
async function disposeClient() {
  if (client) {
    await client.dispose();
    client = null;
    isConnected = false;
    console.log("[SDK] Client disposed");
  }
}

/**
 * 打开文档并创建会话
 * @param {string} docPath - 文档路径
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>} - 文档对象
 */
async function openDocument(docPath, sessionId) {
  const sdkClient = await getClient();
  
  // 使用 sessionId 如果提供
  const options = sessionId ? { session: sessionId } : {};
  const doc = await sdkClient.open({ doc: docPath, ...options });
  
  console.log(`[SDK] Document opened: ${docPath}`);
  return doc;
}

/**
 * 关闭文档会话
 * @param {object} doc - 文档对象
 */
async function closeDocument(doc) {
  if (doc) {
    await doc.close();
    console.log("[SDK] Document closed");
  }
}

/**
 * 保存文档
 * @param {object} doc - 文档对象
 * @param {object} options - 保存选项
 */
async function saveDocument(doc, options = { inPlace: true }) {
  if (doc) {
    await doc.save(options);
    console.log("[SDK] Document saved");
  }
}

/**
 * 获取文档文本
 * @param {object} doc - 文档对象
 * @returns {Promise<string>} - 文档纯文本
 */
async function getText(doc) {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.getText();
}

/**
 * 获取文档信息
 * @param {object} doc - 文档对象
 * @returns {Promise<object>} - 文档信息
 */
async function getInfo(doc) {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.info();
}

/**
 * 查询匹配
 * @param {object} doc - 文档对象
 * @param {object} params - 查询参数
 * @returns {Promise<object>} - 查询结果
 */
async function queryMatch(doc, params) {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.query.match(params);
}

/**
 * 应用变更
 * @param {object} doc - 文档对象
 * @param {object} params - 变更参数
 * @returns {Promise<object>} - 变更结果
 */
async function applyMutations(doc, params) {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.mutations.apply(params);
}

// ============ 兼容旧接口（保留但内部使用 SDK）============

/**
 * 打开文档（兼容旧接口）
 * @param {string} docPath - 文档路径
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>} - 文档对象
 */
async function openWithSession(docPath, sessionId) {
  return await openDocument(docPath, sessionId);
}

/**
 * 关闭会话（兼容旧接口）
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>}
 */
async function closeSession(sessionId) {
  // SDK 方式不需要手动关闭 session，通过关闭 document 实现
  return { success: true };
}

/**
 * 保存会话（兼容旧接口）
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>}
 */
async function saveSession(sessionId) {
  // SDK 方式不需要手动保存 session
  return { success: true };
}

/**
 * 执行查询命令并解析（兼容旧接口）
 * @param {string[]} args - 参数数组（已废弃）
 * @returns {Promise<object>}
 */
async function runQuery(args) {
  // 旧接口保留，实际使用在 sessionManager 中处理
  throw new Error("runQuery is deprecated, use SDK directly");
}

/**
 * 执行命令（兼容旧接口）
 * @param {string[]} args - CLI 参数数组
 * @returns {Promise<string>}
 */
async function runCommand(args) {
  // 旧接口保留，实际使用在 sessionManager 中处理
  throw new Error("runCommand is deprecated, use SDK directly");
}

module.exports = {
  getClient,
  disposeClient,
  openDocument,
  closeDocument,
  saveDocument,
  getText,
  getInfo,
  queryMatch,
  applyMutations,
  // 兼容旧接口
  runCommand,
  openWithSession,
  closeSession,
  saveSession,
  runQuery,
  DOCS_DIR,
};
