const path = require("path");
const { 
  disposeClient,
  openDocument, 
  closeDocument, 
  saveDocument, 
  DOCS_DIR 
} = require("../cliRunner");
const { getDocumentById } = require("../docServices");

/**
 * 活跃会话存储
 * 结构: Map<docId, { sessionId, doc, docPath, createdAt }>
 */
const sessions = new Map();
const rooms = new Map();
const HOCUSPOCUS_URL = process.env.HOCUSPOCUS_URL || "ws://localhost:1234";

function resolveRoomName(docId, metadata) {
  return metadata?.roomName || docId;
}

/**
 * 创建或使用已有会话
 * @param {string} docId - 文档 ID（不含 .docx 后缀）
 * @returns {Promise<object>} - { sessionId, doc }
 */
async function createOrUseSession(docId) {
  const metadata = getDocumentById(docId);
  if (!metadata) {
    throw new Error(`文档不存在: ${docId}`);
  }

  const roomName = resolveRoomName(docId, metadata);

  // 检查会话是否已存在
  if (sessions.has(docId)) {
    const session = sessions.get(docId);
    console.log(`[SessionManager] 使用已有会话: ${session.sessionId} for ${docId}`);
    return { sessionId: session.sessionId, doc: session.doc };
  }

  // 创建新会话
  const docPath = path.join(DOCS_DIR, metadata.storedName);
  const sessionId = `session-${roomName}-${Date.now()}`;

  console.log(`[SessionManager] 创建新会话: ${sessionId} for ${docId}`);

  // 使用 SDK 打开文档
  const doc = await openDocument(docPath, sessionId);

  sessions.set(docId, {
    sessionId,
    doc,
    docPath,
    roomName,
    createdAt: Date.now(),
  });

  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      roomName,
      docId,
      createdAt: Date.now(),
    });
  }

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

  const metadata = getDocumentById(docId);
  const roomName = session.roomName || resolveRoomName(docId, metadata);

  sessions.delete(docId);
  if (roomName) {
    rooms.delete(roomName);
  }
}

/**
 * 保存文档（触发 Yjs 同步）
 * @param {string} docId - 文档 ID
 */
async function saveDocumentById(docId) {
  const session = sessions.get(docId);
  if (!session) {
    console.log(`[SessionManager] 会话不存在: ${docId}`);
    throw new Error("会话不存在");
  }

  console.log(`[SessionManager] 保存文档: ${session.sessionId} for ${docId}`);

  try {
    await saveDocument(session.doc, { inPlace: true });
    console.log(`[SessionManager] 文档已保存，Yjs 同步触发`);
  } catch (e) {
    console.error(`[SessionManager] 保存失败: ${e.message}`);
    throw e;
  }
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
  rooms.clear();

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
 * 确保 Yjs 协作 Room 已创建
 * 在前端连接前调用，确保 room 已存在
 * @param {string} docId - 文档 ID
 * @returns {Promise<void>}
 */
async function ensureYjsRoom(docId) {
  const metadata = getDocumentById(docId);
  if (!metadata) {
    throw new Error(`文档不存在: ${docId}`);
  }

  const roomName = resolveRoomName(docId, metadata);

  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      roomName,
      docId,
      createdAt: Date.now(),
    });
  }

  if (!sessions.has(docId)) {
    console.log(`[SessionManager] 创建 Yjs Room: ${roomName} (docId: ${docId})`);
    await createOrUseSession(docId);
  } else {
    console.log(`[SessionManager] Yjs Room 已存在: ${roomName} (docId: ${docId})`);
  }

  return {
    docId,
    roomName,
    wsUrl: HOCUSPOCUS_URL,
    hasSession: sessions.has(docId),
  };
}

/**
 * 获取所有活跃会话的文档 ID 列表
 * @returns {string[]}
 */
function getActiveSessionDocIds() {
  return Array.from(sessions.keys());
}

function getRoomInfoByDocId(docId) {
  const metadata = getDocumentById(docId);
  if (!metadata) {
    return null;
  }

  const roomName = resolveRoomName(docId, metadata);
  const room = rooms.get(roomName);

  return {
    docId,
    roomName,
    wsUrl: HOCUSPOCUS_URL,
    createdAt: room?.createdAt || null,
    hasSession: sessions.has(docId),
  };
}

module.exports = {
  createOrUseSession,
  getSessionDoc,
  closeSessionByDocId,
  saveDocumentById,
  closeAllSessions,
  getSession,
  hasSession,
  getActiveSessionDocIds,
  ensureYjsRoom,
  getRoomInfoByDocId,
};
