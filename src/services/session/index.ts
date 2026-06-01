/**
 * ============================================================
 * 【会话管理模块入口 - session/index.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是会话管理模块的入口文件，负责：
 * 1. 统一导出所有会话管理函数
 * 2. 作为会话管理模块的统一出口
 * 
 * 【架构位置】
 * docRoutes.ts → import * as sessionManager from "../services/session"
 *   ↓
 * 【session/index.ts】 → 导出所有会话管理函数
 *   ↓
 * sessionManager.ts → 实际实现
 * 
 * 【数据流】
 * 路由调用sessionManager.createOrUseSession()
 *   ↓
 * index.ts重导出到sessionManager.createOrUseSession()
 *   ↓
 * sessionManager.ts执行实际的会话创建操作
 * 
 * 【导出的函数】
 * - createOrUseSession: 创建或使用会话
 * - closeSessionByDocId: 根据文档ID关闭会话
 * - closeAllSessions: 关闭所有会话
 * - ensureYjsRoom: 确保Yjs房间存在
 * - saveSessionDocument: 保存会话文档
 * - saveSessionDocuments: 批量保存会话文档
 * 
 * 【使用方式】
 * import * as sessionManager from "../services/session";
 * 
 * // 创建或使用会话
 * const result = await sessionManager.createOrUseSession(docId);
 * 
 * // 关闭会话
 * await sessionManager.closeSessionByDocId(docId, "delete");
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【会话管理模块】
// 导入所有会话管理函数
import * as sessionManager from "./sessionManager";

// ================================================================
// 【会话管理函数导出】
// ================================================================

/**
 * 【创建或使用会话】
 * 
 * 【功能说明】
 * 创建或复用文档会话
 * 如果已有活跃会话，直接复用
 * 否则创建新会话
 * 
 * @see sessionManager.createOrUseSession
 */
export const createOrUseSession = sessionManager.createOrUseSession;

/**
 * 【根据文档ID关闭会话】
 * 
 * 【功能说明】
 * 关闭指定文档的会话
 * 
 * @see sessionManager.closeSessionByDocId
 */
export const closeSessionByDocId = sessionManager.closeSessionByDocId;

/**
 * 【关闭所有会话】
 * 
 * 【功能说明】
 * 关闭所有活跃的会话
 * 销毁SDK客户端
 * 
 * @see sessionManager.closeAllSessions
 */
export const closeAllSessions = sessionManager.closeAllSessions;

/**
 * 【确保Yjs房间存在】
 * 
 * 【功能说明】
 * 确保Yjs协作房间存在
 * 返回房间信息供前端连接
 * 
 * @see sessionManager.ensureYjsRoom
 */
export const ensureYjsRoom = sessionManager.ensureYjsRoom;

/**
 * 【保存会话文档】
 * 
 * 【功能说明】
 * 保存当前会话中的文档状态
 * 
 * @see sessionManager.saveSessionDocument
 */
export const saveSessionDocument = sessionManager.saveSessionDocument;

/**
 * 【批量保存会话文档】
 * 
 * 【功能说明】
 * 批量保存多个文档的会话状态
 * 
 * @see sessionManager.saveSessionDocuments
 */
export const saveSessionDocuments = sessionManager.saveSessionDocuments;
