import {
  disposeClient,
  openDocument,
  closeDocument,
  Document,
} from "../cliRunner";
import { getDocumentById } from "../docServices";
import config from "../../config";

const sessions = new Map<string, any>();
const HOCUSPOCUS_URL = config.HOCUSPOCUS_URL;

// ===== SDK 句柄管理 =====

/**
 * 通过文档 ID 获取房间名
 */
function resolveRoomName(docId: string, metadata: any) {
  return metadata?.roomName || docId;
}

/**
 * Agent 加入已有协作房间
 * 使用 onMissing: "error" - 房间必须已存在（前端已打开）
 */
export async function createOrUseSession(docId: string): Promise<{ sessionId: string; doc: Document }> {
  const metadata = getDocumentById(docId);
  if (!metadata) throw new Error(`文档不存在: ${docId}`);
  const roomName = resolveRoomName(docId, metadata);

  // 检查是否有已有会话，直接复用
  if (sessions.has(docId)) {
    const session = sessions.get(docId);
    console.log(`[SessionManager] 使用已有会话: ${session.sessionId} for ${docId}`);
    return { sessionId: session.sessionId, doc: session.doc };
  }

  // 获取已存储文件路径
  const { DOCS_DIR } = await import("../cliRunner");
  const filePath = metadata.filePath?.replace("/uploads/", "") || metadata.storedName;
  const docPath = filePath.startsWith("/") ? filePath : `${DOCS_DIR}/${filePath}`;

  const sessionId = `session-${roomName}-${Date.now()}`;
  console.log(`[SessionManager] Agent 加入房间: ${sessionId} for ${docId}, room=${roomName}`);

  // 使用 onMissing: "error" - 必须加入已有房间，不能播种
  const doc = await openDocument({
    docPath,
    sessionId,
    collaboration: {
      providerType: "hocuspocus",
      url: HOCUSPOCUS_URL,
      documentId: roomName,
      onMissing: "error", // 房间必须已存在，否则报错
      bootstrapSettlingMs: 5000, // 延长握手等待时间，从默认1500增加到5000ms
    },
  });

  sessions.set(docId, { sessionId, doc, docPath, roomName, createdAt: Date.now() });
  return { sessionId, doc };
}

// ===== 会话查询 =====

/**
 * 获取 SDK 文档句柄
 */
export function getSessionDoc(docId: string): Document | null {
  const session = sessions.get(docId);
  return session ? session.doc : null;
}

/**
 * 获取完整会话信息
 */
export function getSession(docId: string): any {
  const session = sessions.get(docId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    doc: session.doc,
    docPath: session.docPath,
    roomName: session.roomName,
  };
}

/**
 * 检查会话是否存在
 */
export function hasSession(docId: string): boolean {
  return sessions.has(docId);
}

/**
 * 获取所有活跃会话的文档 ID
 */
export function getActiveSessionDocIds(): string[] {
  return Array.from(sessions.keys());
}

/**
 * 获取协作房间信息
 */
export async function ensureYjsRoom(
  docId: string
): Promise<{ docId: string; roomName: string; wsUrl: string }> {
  const metadata = getDocumentById(docId);
  if (!metadata) throw new Error(`文档不存在: ${docId}`);
  const roomName = resolveRoomName(docId, metadata);
  return { docId, roomName, wsUrl: HOCUSPOCUS_URL };
}

// ===== 会话关闭 =====

/**
 * 关闭单个会话
 */
export async function closeSessionByDocId(docId: string): Promise<void> {
  const session = sessions.get(docId);
  if (!session) {
    console.log(`[SessionManager] 会话不存在: ${docId}`);
    return;
  }
  console.log(`[SessionManager] 关闭会话: ${session.sessionId} for ${docId}`);
  try {
    await closeDocument(session.doc);
  } catch (e) {
    console.error(`[SessionManager] 关闭失败: ${(e as Error).message}`);
  }
  sessions.delete(docId);
}

/**
 * 关闭所有会话
 */
export async function closeAllSessions(): Promise<void> {
  console.log(`[SessionManager] 关闭所有会话，当前活跃: ${sessions.size}`);
  const docIds = Array.from(sessions.keys());
  for (const docId of docIds) {
    await closeSessionByDocId(docId);
  }
  await disposeClient();
  console.log(`[SessionManager] 所有会话已关闭`);
}