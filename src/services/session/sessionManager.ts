// 会话管理器（SessionManager）— 管理 SDK 文档会话的生命周期
// 核心职责：
//   1. createOrUseSession — 创建或复用 SDK 文档会话
//   2. ensureYjsRoom — 获取 Yjs 协作房间信息
//   3. closeSessionByDocId / closeAllSessions — 关闭会话释放资源
//   4. 空闲会话定时清理 — 防止长时间不活跃的会话占用 SDK 连接
// 会话通过 collabUrl + collabDocumentId 参数以 y-websocket 协议连接协作服务

import {
  disposeClient,
  openDocument,
  closeDocument,
  Document,
} from "../cliRunner";
import { getDocumentById } from "../docServices";
import config from "../../config";

// 会话存储 — key 为 docId，value 为会话详情
const sessions = new Map<string, { sessionId: string; doc: Document; docPath: string; roomName: string; createdAt: number; lastActivity: number }>();
const COLLAB_WS_URL = config.COLLAB_WS_URL;

// 会话空闲超时 — 30 分钟无活动自动清理
// 为什么是 30 分钟：平衡资源占用和用户体验，正常编辑间隔远小于此
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// 定时清理器 — 每分钟扫描一次过期会话
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// startSessionCleanup — 启动定时清理，使用 setInterval 每分钟检查
// 防止因异常（浏览器关闭、网络断开）遗留的孤儿会话持续占用 SDK 连接
function startSessionCleanup(): void {
  if (cleanupTimer) return;  // 防止重复启动
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [docId, session] of sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        console.log(`[SessionManager] 清理过期会话: ${session.sessionId} (空闲超时)`);
        try {
          void closeDocument(session.doc);
        } catch (e) {
          console.error(`[SessionManager] 关闭过期会话失败: ${(e as Error).message}`);
        }
        sessions.delete(docId);
      }
    }
  }, 60 * 1000);
}

// 模块加载时自动启动清理器
startSessionCleanup();

// resolveRoomName — 解析房间名，优先使用元数据中的 roomName，回退到 docId
function resolveRoomName(docId: string, metadata: any) {
  return metadata?.roomName || docId;
}

// createOrUseSession — 创建或复用文档的 SDK 会话
// 这是会话管理的核心入口，Agent 对文档的任何操作都通过此函数获取文档句柄
// 设计要点：
//   1. 复用优先：如果该 docId 已有活跃会话，直接返回（更新 lastActivity）
//   2. 协作连接：使用 collabUrl + collabDocumentId 缩略参数，SDK 自动处理 y-websocket 连接
//   3. 超时容错：连接超时时自动 disposeClient，允许下次请求重试
// 输入：docId（文档 ID）
// 输出：{ sessionId, doc }（会话 ID 和 SDK 文档句柄）
export async function createOrUseSession(docId: string): Promise<{ sessionId: string; doc: Document }> {
  const metadata = await getDocumentById(docId);
  if (!metadata) throw new Error(`文档不存在: ${docId}`);
  const roomName = resolveRoomName(docId, metadata);

  // 检查是否有已有会话，直接复用（避免重复创建 SDK 连接）
  if (sessions.has(docId)) {
    const session = sessions.get(docId)!;
    session.lastActivity = Date.now(); // 更新活跃时间，防止被空闲清理误杀
    console.log(`[SessionManager] 使用已有会话: ${session.sessionId} for ${docId}`);
    return { sessionId: session.sessionId, doc: session.doc };
  }

  // 获取已存储文件路径
  const { DOCS_DIR } = await import("../cliRunner");
  const filePath = metadata.filePath?.replace("/uploads/", "") || metadata.storedName;
  const docPath = filePath.startsWith("/") ? filePath : `${DOCS_DIR}/${filePath}`;

  const sessionId = `session-${roomName}-${Date.now()}`;
  console.log(`[SessionManager] Agent 加入房间: ${sessionId} for ${docId}, room=${roomName}`);

  try {
    // 以协作模式打开文档 — collabUrl + collabDocumentId 告诉 SDK 连接指定房间
    const doc = await openDocument({
      docPath,
      sessionId,
      collabUrl: COLLAB_WS_URL,         // y-websocket 服务地址
      collabDocumentId: roomName,       // 协作房间名
    });

    sessions.set(docId, { sessionId, doc, docPath, roomName, createdAt: Date.now(), lastActivity: Date.now() });
    return { sessionId, doc };
  } catch (error: any) {
    // 超时检测 — 超时时销毁客户端，避免下次操作继续使用问题连接
    const isTimeout = error?.code === 'COLLABORATION_SYNC_TIMEOUT'
      || error?.code === 'HOST_WATCHDOG_TIMEOUT'
      || (error?.message && typeof error.message === 'string' && 
          (error.message.includes('sync timed out') || error.message.includes('watchdog timed') || error.message.includes('request timed out')));
    if (isTimeout) {
      console.warn(`[SessionManager] 协作超时，重置 SDK 客户端: ${error.message}`);
      await disposeClient();
    }
    throw error;
  }
}

// ensureYjsRoom — 获取协作用房间信息（不创建 SDK 会话）
// 前端调用此函数获取 roomName/wsUrl 用于连接协作服务
// 与 createOrUseSession 的区别：不打开 SDK 文档句柄，只返回房间连接参数
export async function ensureYjsRoom(
  docId: string
): Promise<{ docId: string; roomName: string; wsUrl: string }> {
  const metadata = await getDocumentById(docId);
  if (!metadata) throw new Error(`文档不存在: ${docId}`);
  const roomName = resolveRoomName(docId, metadata);
  return { docId, roomName, wsUrl: COLLAB_WS_URL };
}

// closeSessionByDocId — 关闭指定文档的 SDK 会话
// 删除文档或用户主动关闭时调用
// 先关闭文档句柄再清除会话记录，确保资源正确释放
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

// closeAllSessions — 关闭所有活跃会话并销毁 SDK 客户端
// 调用时机：cleanup 操作、服务关闭前
// 关闭所有会话后 disposeClient 确保 SDK 连接完全释放
export async function closeAllSessions(): Promise<void> {
  console.log(`[SessionManager] 关闭所有会话，当前活跃: ${sessions.size}`);
  const docIds = Array.from(sessions.keys());
  for (const docId of docIds) {
    await closeSessionByDocId(docId);
  }
  await disposeClient();
  console.log(`[SessionManager] 所有会话已关闭`);
}
