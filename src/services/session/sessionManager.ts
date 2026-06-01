/**
 * ============================================================
 * 【会话管理器 - sessionManager.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是会话管理的核心模块，负责：
 * 1. 管理SuperDoc SDK的会话生命周期
 * 2. 创建或复用文档会话
 * 3. 保存会话文档状态
 * 4. 关闭会话和清理资源
 * 5. 空闲会话自动清理
 * 
 * 【架构位置】
 * docRoutes.ts → 【sessionManager】 → cliRunner.ts → @superdoc-dev/sdk
 * 
 * 【数据流】
 * 路由调用createOrUseSession(docId)
 *   ↓
 * 检查是否有现有会话
 *   ↓
 * 如果有，复用会话
 *   ↓
 * 如果没有，调用cliRunner.openDocument()创建新会话
 *   ↓
 * 存储会话信息
 *   ↓
 * 返回会话结果
 * 
 * 【会话管理策略】
 * - 每个文档最多一个会话
 * - 会话有空闲超时（30分钟）
 * - 超时的会话自动关闭
 * - 支持手动关闭和批量关闭
 * 
 * 【使用的模块】
 * cliRunner.ts: SDK客户端管理
 *   - openDocument: 打开文档
 *   - closeDocument: 关闭文档
 *   - disposeClient: 销毁客户端
 * 
 * config: 应用配置
 *   - COLLAB_WS_URL: 协作WebSocket地址
 * 
 * docServices: 文档服务
 *   - getDocumentById: 根据ID获取文档
 *   - refreshSavedStateFromDisk: 刷新保存状态
 *   - UPLOAD_DIR: 上传目录路径
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【CLI Runner模块】
// SDK客户端管理模块
import {
  closeDocument,    // 关闭文档
  disposeClient,    // 销毁客户端
  openDocument,     // 打开文档
  type RoomDocument, // 文档句柄类型
  type RoomSessionResult, // 会话结果类型
} from "../cliRunner";

// 【应用配置】
import config from "../../config";

// 【文档服务】
import { getDocumentById, refreshSavedStateFromDisk, UPLOAD_DIR } from "../docServices";

// ================================================================
// 【类型定义】
// ================================================================

/**
 * 【会话条目类型】
 * 
 * 【功能说明】
 * 存储单个会话的所有信息
 * 
 * 【字段说明】
 * @property sessionId - 会话唯一标识符
 * @property doc - 文档句柄（SuperDocDocument）
 * @property docPath - 文档文件路径
 * @property roomName - 协作房间名
 * @property createdAt - 创建时间（时间戳）
 * @property lastActivity - 最后活动时间（时间戳）
 */
type SessionEntry = {
  sessionId: string;
  doc: RoomDocument;
  docPath: string;
  roomName: string;
  createdAt: number;
  lastActivity: number;
};

// ================================================================
// 【会话存储】
// ================================================================

/**
 * 【会话存储Map】
 * 
 * 【功能说明】
 * 存储所有活跃的会话
 * key: 文档ID
 * value: 会话条目
 */
const sessions = new Map<string, SessionEntry>();

/**
 * 【协作WebSocket地址】
 * 
 * 【功能说明】
 * 从配置中获取协作WebSocket地址
 * 用于打开文档时连接协作服务
 */
const COLLAB_WS_URL = config.COLLAB_WS_URL;

/**
 * 【会话空闲超时时间】
 * 
 * 【功能说明】
 * 会话空闲超时时间（毫秒）
 * 默认30分钟
 * 超时的会话会被自动关闭
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 【清理定时器】
 * 
 * 【功能说明】
 * 用于定期清理空闲会话的定时器
 */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ================================================================
// 【辅助函数】
// ================================================================

/**
 * 【解析房间名】
 * 
 * 【功能说明】
 * 从文档元数据中解析房间名
 * 如果元数据中有roomName则使用，否则使用docId
 * 
 * @param docId - 文档ID
 * @param metadata - 文档元数据
 * @returns 房间名
 */
function resolveRoomName(docId: string, metadata: any): string {
  return metadata?.roomName || docId;
}

/**
 * 【启动会话清理】
 * 
 * 【功能说明】
 * 启动定期清理空闲会话的定时器
 * 每60秒检查一次，关闭超时的会话
 * 
 * 【执行流程】
 * 1. 检查是否已有定时器
 * 2. 如果没有，创建定时器
 * 3. 定时器每60秒执行一次
 * 4. 遍历所有会话，检查最后活动时间
 * 5. 关闭超时的会话
 */
function startSessionCleanup(): void {
  if (cleanupTimer) {
    return;
  }

  cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [docId, session] of sessions) {
      // 【检查是否超时】
      if (now - session.lastActivity <= SESSION_IDLE_TIMEOUT_MS) {
        continue;
      }

      // 【关闭超时会话】
     console.log(
        `[SessionManager] Closing idle session: ${session.sessionId}`,
      );
      void closeDocument(session.doc, `idle-timeout:${docId}`);
      sessions.delete(docId);
    }
  }, 60 * 1000);
}

// 【启动会话清理】
startSessionCleanup();

// ================================================================
// 【会话管理函数】
// ================================================================

/**
 * 【创建或使用会话】
 * 
 * 【功能说明】
 * 创建或复用文档会话
 * 如果已有活跃会话，直接复用
 * 否则创建新会话
 * 
 * 【执行流程】
 * 1. 获取文档元数据
 * 2. 检查是否有现有会话
 * 3. 如果有，更新最后活动时间，返回现有会话
 * 4. 如果没有，解析房间名和文件路径
 * 5. 调用cliRunner.openDocument()创建新会话
 * 6. 存储会话信息
 * 7. 返回会话结果
 * 
 * 【错误处理】
 * 如果发生超时错误，销毁客户端
 * 
 * @param docId - 文档ID
 * @returns 会话结果
 */
export async function createOrUseSession(
  docId: string,
): Promise<RoomSessionResult> {
  // 【获取文档元数据】
  const metadata = await getDocumentById(docId);
  if (!metadata) {
    throw new Error(文档不存在: );
  }

  // 【检查是否有现有会话】
  const existing = sessions.get(docId);
  if (existing) {
    // 【更新最后活动时间】
    existing.lastActivity = Date.now();
    console.log(
      `[SessionManager] Reusing session: ${existing.sessionId} for ${docId}`,
    );
    return { sessionId: existing.sessionId, doc: existing.doc };
  }

  // 【解析房间名】
  const roomName = resolveRoomName(docId, metadata);
  
  // 【解析文件路径】
  const fileName =
    metadata.filePath?.replace("/uploads/", "") || metadata.storedName;
  const docPath = fileName.startsWith("/")
    ? fileName
  : `${UPLOAD_DIR}/${fileName}`;
  const sessionId = `session-${roomName}-${Date.now()}`;

  console.log(
    `[SessionManager] Opening room session: ${sessionId} for ${docId}, room=${roomName}`,
  );

  try {
    // 【打开文档】
    const doc = await openDocument({
      docPath,
      sessionId,
      collabUrl: COLLAB_WS_URL,
      collabDocumentId: roomName,
    });

    // 【存储会话信息】
    sessions.set(docId, {
      sessionId,
      doc,
      docPath,
      roomName,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    return { sessionId, doc };
  } catch (error: any) {
    // 【检查是否是超时错误】
    const isTimeout =
      error?.code === "COLLABORATION_SYNC_TIMEOUT" ||
      error?.code === "HOST_WATCHDOG_TIMEOUT" ||
      (typeof error?.message === "string" &&
        (error.message.includes("sync timed out") ||
          error.message.includes("watchdog timed") ||
          error.message.includes("request timed out")));

    // 【如果是超时错误，销毁客户端】
    if (isTimeout) {
      console.warn(
        `[SessionManager] Collaboration open timed out, disposing client: ${error.message}`,
      );
      await disposeClient();
    }

    throw error;
  }
}

/**
 * 【确保Yjs房间存在】
 * 
 * 【功能说明】
 * 确保Yjs协作房间存在
 * 返回房间信息供前端连接
 * 
 * 【执行流程】
 * 1. 获取文档元数据
 * 2. 解析房间名
 * 3. 返回房间信息
 * 
 * @param docId - 文档ID
 * @returns 房间信息
 */
export async function ensureYjsRoom(
  docId: string,
): Promise<{ docId: string; roomName: string; wsUrl: string }> {
  const metadata = await getDocumentById(docId);
  if (!metadata) {
     throw new Error(`文档不存在: ${docId}`);
  }

  return {
    docId,
    roomName: resolveRoomName(docId, metadata),
    wsUrl: COLLAB_WS_URL,
  };
}

/**
 * 【保存会话文档】
 * 
 * 【功能说明】
 * 保存当前会话中的文档状态
 * 如果没有活跃会话，从磁盘刷新保存状态
 * 
 * 【执行流程】
 * 1. 检查是否有活跃会话
 * 2. 如果有，调用doc.save()保存文档
 * 3. 刷新保存状态
 * 4. 更新最后活动时间
 * 5. 返回保存结果
 * 
 * @param docId - 文档ID
 * @returns 保存结果
 */
export async function saveSessionDocument(
  docId: string,
): Promise<{ saved: boolean; hash: string; docId: string }> {
  const session = sessions.get(docId);
  
  // 【如果没有活跃会话】
  if (!session) {
    console.log([SessionManager] Save without active session: );
    const result = await refreshSavedStateFromDisk(docId);
    return { saved: result.saved, hash: result.hash, docId };
  }

  // 【保存活跃会话】
  console.log(
    `[SessionManager] Saving active session: ${session.sessionId} for ${docId}`,
  );
  
  // 【调用doc.save()保存文档】
  await session.doc.save({ inPlace: true });
  
  // 【刷新保存状态】
  const result = await refreshSavedStateFromDisk(docId);
  
  // 【更新最后活动时间】
  session.lastActivity = Date.now();
  
  return { saved: result.saved, hash: result.hash, docId };
}

/**
 * 【批量保存会话文档】
 * 
 * 【功能说明】
 * 批量保存多个文档的会话状态
 * 
 * @param docIds - 文档ID数组
 * @returns 保存结果数组
 */
export async function saveSessionDocuments(
  docIds: string[],
): Promise<Array<{ saved: boolean; hash: string; docId: string; error?: string }>> {
  // 【去重】
  const uniqueIds = Array.from(new Set(docIds));
  const results = [];

  // 【遍历保存】
  for (const docId of uniqueIds) {
    try {
      results.push(await saveSessionDocument(docId));
    } catch (error) {
      results.push({
        docId,
        saved: false,
        hash: "",
        error: error instanceof Error ? error.message : "保存失败",
      });
    }
  }

  return results;
}

/**
 * 【根据文档ID关闭会话】
 * 
 * 【功能说明】
 * 关闭指定文档的会话
 * 
 * @param docId - 文档ID
 * @param reason - 关闭原因
 */
export async function closeSessionByDocId(
  docId: string,
  reason = "unspecified",
): Promise<void> {
  const session = sessions.get(docId);
  
  // 【检查会话是否存在】
  if (!session) {
    console.log(`[SessionManager] No session found for ${docId}, reason=${reason}`);
    return;
  }

  // 【关闭会话】
  console.log(
    `[SessionManager] Closing session: ${session.sessionId} for ${docId}, reason=${reason}`,
  );
  await closeDocument(session.doc, reason);
  sessions.delete(docId);
}

/**
 * 【关闭所有会话】
 * 
 * 【功能说明】
 * 关闭所有活跃的会话
 * 销毁SDK客户端
 * 
 * @param reason - 关闭原因
 */
export async function closeAllSessions(reason = "unspecified"): Promise<void> {
  console.log(
    `[SessionManager] Closing all sessions: ${sessions.size}, reason=${reason}`,
  );

  // 【遍历关闭所有会话】
  for (const docId of Array.from(sessions.keys())) {
    await closeSessionByDocId(docId, reason);
  }

  // 【销毁SDK客户端】
  await disposeClient();
}
