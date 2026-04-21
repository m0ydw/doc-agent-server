const path = require("path");
const { 
  getClient, 
  disposeClient,
  openDocument, 
  closeDocument, 
  saveDocument, 
  DOCS_DIR 
} = require("../cliRunner");

/**
 * 活跃会话存储
 * 结构: Map<docId, { sessionId, doc, docPath, createdAt }>
 */
const sessions = new Map();

/**
 * 创建或使用已有会话
 * @param {string} docId - 文档 ID（不含 .docx 后缀）
 * @returns {Promise<object>} - { sessionId, doc }
 */
async function createOrUseSession(docId) {
  // 检查会话是否已存在
  if (sessions.has(docId)) {
    const session = sessions.get(docId);
    console.log(`[SessionManager] 使用已有会话: ${session.sessionId} for ${docId}`);
    return { sessionId: session.sessionId, doc: session.doc };
  }

  // 创建新会话
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  const sessionId = `session-${docId}-${Date.now()}`;

  console.log(`[SessionManager] 创建新会话: ${sessionId} for ${docId}`);

  // 使用 SDK 打开文档
  const doc = await openDocument(docPath, sessionId);

  sessions.set(docId, {
    sessionId,
    doc,
    docPath,
    createdAt: Date.now(),
  });

  return { sessionId, doc };
}

/**
 * 获取会话的文档对象
 * @param {string} docId - 文档 ID
 * @returns {object|null} - 文档对象
 */
function getSessionDoc(docId) {
  const session = sessions.get(docId);
  return session ? session.doc : null;
}

/**
 * 关闭指定会话
 * @param {string} docId - 文档 ID
 */
async function closeSessionByDocId(docId) {
  const session = sessions.get(docId);
  if (!session) {
    console.log(`[SessionManager] 会话不存在: ${docId}`);
    return;
  }

  console.log(`[SessionManager] 关闭会话: ${session.sessionId} for ${docId}`);

  try {
    await closeDocument(session.doc);
  } catch (e) {
    console.error(`[SessionManager] 关闭失败: ${e.message}`);
  }

  sessions.delete(docId);
}

/**
 * 关闭所有会话
 */
async function closeAllSessions() {
  console.log(`[SessionManager] 关闭所有会话，当前活跃: ${sessions.size}`);

  const docIds = Array.from(sessions.keys());

  for (const docId of docIds) {
    await closeSessionByDocId(docId);
  }

  // 关闭 SDK 客户端
  await disposeClient();

  console.log(`[SessionManager] 所有会话已关闭`);
}

/**
 * 获取会话信息
 * @param {string} docId - 文档 ID
 * @returns {object|null}
 */
function getSession(docId) {
  return sessions.get(docId) || null;
}

/**
 * 检查会话是否存在
 * @param {string} docId - 文档 ID
 * @returns {boolean}
 */
function hasSession(docId) {
  return sessions.has(docId);
}

/**
 * 获取所有活跃会话的文档 ID 列表
 * @returns {string[]}
 */
function getActiveSessionDocIds() {
  return Array.from(sessions.keys());
}

module.exports = {
  createOrUseSession,
  getSessionDoc,
  closeSessionByDocId,
  closeAllSessions,
  getSession,
  hasSession,
  getActiveSessionDocIds,
};
