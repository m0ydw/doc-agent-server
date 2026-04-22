const path = require("path");
const Y = require("yjs");
const { Editor, getStarterExtensions } = require("superdoc/super-editor");
const {
  disposeClient,
  openDocument,
  closeDocument,
  saveDocument,
  DOCS_DIR,
} = require("../cliRunner");
const { getDocumentById } = require("../docServices");
const config = require("../../config");

/**
 * 活跃会话存储
 * 结构: Map<docId, { sessionId, doc, docPath, roomName, createdAt }>
 */
const sessions = new Map();

/**
 * 协作房间存储
 * 结构: Map<roomName, { roomName, docId, ydoc, createdAt, lastActiveAt }>
 */
const rooms = new Map();

const HOCUSPOCUS_URL = config.HOCUSPOCUS_URL;

function resolveRoomName(docId, metadata) {
  return metadata?.roomName || docId;
}

function touchRoom(room, docId) {
  if (docId && !room.docId) {
    room.docId = docId;
  }
  room.lastActiveAt = Date.now();
  return room;
}

async function ensureRoom(roomName, docId, metadata) {
  const existing = rooms.get(roomName);
  if (existing) {
    return touchRoom(existing, docId);
  }

  // 1. 创建 ydoc
  const ydoc = new Y.Doc();

  // 2. 使用 metadata 获取 docPath
  if (metadata) {
    const docPath = path.join(DOCS_DIR, metadata.storedName);
    try {
      const fragment = ydoc.getXmlFragment("prosemirror");
      const editor = new Editor({
        mode: "docx",
        isHeadless: true,
        extensions: getStarterExtensions(),
        fragment,
      });
      
      await editor.open(docPath);
      console.log(`[ensureRoom] 已加载 docx 到 ydoc: ${docPath}`);
      
      ydoc._editor = editor;
    } catch (error) {
      console.error(`[ensureRoom] 加载 docx 失败: ${error.message}`);
    }
  }

  const room = {
    roomName,
    docId: docId || null,
    ydoc,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  rooms.set(roomName, room);
  return room;
}

function getRoomByDocId(docId) {
  const metadata = getDocumentById(docId);
  const roomName = resolveRoomName(docId, metadata);
  return rooms.get(roomName) || null;
}

async function getOrCreateRoomYDoc(roomName, docId) {
  let metadata = null;
  if (docId) {
    metadata = getDocumentById(docId);
  }
  const room = await ensureRoom(roomName, docId, metadata);
  return room.ydoc;
}

function removeRoomByName(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;

  // 销毁 editor
  if (room.ydoc._editor) {
    room.ydoc._editor.destroy();
    delete room.ydoc._editor;
  }
  
  if (room.ydoc && typeof room.ydoc.destroy === "function") {
    room.ydoc.destroy();
  }
  rooms.delete(roomName);
}

function removeRoomByDocId(docId) {
  const session = sessions.get(docId);
  const metadata = getDocumentById(docId);
  const roomName = session?.roomName || resolveRoomName(docId, metadata);
  if (roomName) {
    removeRoomByName(roomName);
  }
}

/**
 * 创建或使用已有会话
 * 说明：会话以协作模式连接 Hocuspocus 房间，编辑操作直接作用于 Yjs。
 * @param {string} docId - 文档 ID
 * @returns {Promise<object>} - { sessionId, doc }
 */
async function createOrUseSession(docId) {
  const metadata = getDocumentById(docId);
  if (!metadata) {
    throw new Error(`文档不存在: ${docId}`);
  }

  const roomName = resolveRoomName(docId, metadata);
  await ensureRoom(roomName, docId, metadata);

  if (sessions.has(docId)) {
    const session = sessions.get(docId);
    console.log(
      `[SessionManager] 使用已有会话: ${session.sessionId} for ${docId}`
    );
    return { sessionId: session.sessionId, doc: session.doc };
  }

  const docPath = path.join(DOCS_DIR, metadata.storedName);
  const sessionId = `session-${roomName}-${Date.now()}`;

  console.log(
    `[SessionManager] 创建协作会话: ${sessionId} for ${docId}, room=${roomName}`
  );

  const doc = await openDocument({
    docPath,
    sessionId,
    collaboration: {
      providerType: "hocuspocus",
      url: HOCUSPOCUS_URL,
      documentId: roomName,
      onMissing: "error",
    },
  });

  sessions.set(docId, {
    sessionId,
    doc,
    docPath,
    roomName,
    createdAt: Date.now(),
  });

  return { sessionId, doc };
}

/**
 * 获取会话的文档对象
 * @param {string} docId - 文档 ID
 * @returns {object|null}
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
  } catch (error) {
    console.error(`[SessionManager] 关闭失败: ${error.message}`);
  }

  sessions.delete(docId);
}

/**
 * 保存文档（触发 Yjs 同步）
 * @param {string} docId - 文档 ID
 */
async function saveDocumentById(docId) {
  let session = sessions.get(docId);
  if (!session) {
    await createOrUseSession(docId);
    session = sessions.get(docId);
  }

  if (!session) {
    throw new Error("会话不存在");
  }

  console.log(`[SessionManager] 保存文档: ${session.sessionId} for ${docId}`);
  await saveDocument(session.doc, { inPlace: true });
  console.log(`[SessionManager] 文档已保存，Yjs 同步触发`);
}

/**
 * 关闭所有会话并清理房间
 */
async function closeAllSessions() {
  console.log(`[SessionManager] 关闭所有会话，当前活跃: ${sessions.size}`);

  const docIds = Array.from(sessions.keys());
  for (const docId of docIds) {
    await closeSessionByDocId(docId);
  }

  await disposeClient();

  const roomNames = Array.from(rooms.keys());
  roomNames.forEach((roomName) => removeRoomByName(roomName));

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
 * 确保 Yjs 协作 Room 与协作会话已创建
 * @param {string} docId - 文档 ID
 * @returns {Promise<object>}
 */
async function ensureYjsRoom(docId) {
  //获取文档数据
  const metadata = getDocumentById(docId);
  if (!metadata) {
    throw new Error(`文档不存在: ${docId}`);
  }
  //获取房间名
  const roomName = resolveRoomName(docId, metadata);
  //创建ydoc并加载docx内容
  await ensureRoom(roomName, docId, metadata);

  if (!sessions.has(docId)) {
    console.log(
      `[SessionManager] 创建 Yjs Room: ${roomName} (docId: ${docId})`
    );
    await createOrUseSession(docId);
  } else {
    console.log(
      `[SessionManager] Yjs Room 已存在: ${roomName} (docId: ${docId})`
    );
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

async function getRoomInfoByDocId(docId) {
  const metadata = getDocumentById(docId);
  if (!metadata) {
    return null;
  }

  const roomName = resolveRoomName(docId, metadata);
  const room = await ensureRoom(roomName, docId, metadata);

  return {
    docId,
    roomName,
    wsUrl: HOCUSPOCUS_URL,
    createdAt: room.createdAt,
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
  getOrCreateRoomYDoc,
  getRoomByDocId,
  removeRoomByDocId,
};
