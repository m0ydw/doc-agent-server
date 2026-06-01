/**
 * ============================================================
 * 【文档管理路由 - docRoutes.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是文档管理的路由文件，负责：
 * 1. 文件上传（支持多文件批量上传）
 * 2. 文档列表获取
 * 3. 文档打开（创建协作会话）
 * 4. 种子文件获取（供前端初始化编辑器）
 * 5. 文档信息查询
 * 6. 文档删除
 * 7. 批量清理
 * 8. 文档保存
 * 
 * 【上传流程】
 * multer解析 → 解码文件名 → 保存磁盘 + 元数据
 *   ↓
 * 注册到文件映射表 → 返回协作信息
 * 
 * 【设计原则】
 * 上传只存盘不连接协作（延迟加载）
 * 用户打开时才建立Yjs房间连接
 * 
 * 【使用的库】
 * express: Web应用框架
 *   - Router: 路由路由器
 *   - Request: 请求对象
 *   - Response: 响应对象
 * 
 * multer: 文件上传中间件
 *   - 处理multipart/form-data格式
 *   - 文件过滤和大小限制
 * 
 * path: Node.js路径模块
 *   - 路径处理（拼接、解析、扩展名）
 * 
 * @/config: 应用配置
 *   - COLLAB_WS_URL: 协作WebSocket地址
 * 
 * @/services/docServices: 文档服务
 *   - saveDocument: 保存文档
 *   - getDocumentList: 获取文档列表
 *   - getDocumentFile: 获取文档文件
 *   - getDocumentById: 根据ID获取文档
 *   - deleteDocument: 删除文档
 *   - cleanupDocuments: 批量清理文档
 *   - saveDocumentContent: 保存文档内容
 * 
 * @/services/session: 会话管理
 *   - createOrUseSession: 创建或使用会话
 *   - closeSessionByDocId: 根据文档ID关闭会话
 *   - closeAllSessions: 关闭所有会话
 *   - ensureYjsRoom: 确保Yjs房间存在
 *   - saveSessionDocument: 保存会话文档
 * 
 * @/services/fileRegistry: 文件注册表
 *   - registerDocument: 注册文档
 *   - unregisterDocument: 注销文档
 *   - initFileRegistry: 初始化文件注册表
 * 
 * @/services/collabStateService: 协作状态服务
 *   - cleanupCollabStates: 清理协作状态
 *   - deleteCollabState: 删除协作状态
 *   - hasCollabState: 检查是否有协作状态
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【Express框架】
// 导入Express及其类型定义
import express, { Request, Response, Router } from "express";

// 【Multer文件上传中间件】
// 处理multipart/form-data格式的文件上传
import multer, { FileFilterCallback } from "multer";

// 【Node.js路径模块】
// 路径处理（拼接、解析、扩展名）
import path from "path";

// 【应用配置】
// 导入配置，包含协作WebSocket地址
import config from "../config";

// 【文档服务】
// 文档的CRUD操作
import {
  saveDocument,        // 保存文档
  getDocumentList,     // 获取文档列表
  getDocumentFile,     // 获取文档文件
  getDocumentById,     // 根据ID获取文档
  deleteDocument,      // 删除文档
  cleanupDocuments,    // 批量清理文档
  saveDocumentContent, // 保存文档内容
  DocumentMetadata,    // 文档元数据类型
} from "../services/docServices";

// 【会话管理服务】
// 管理SuperDoc SDK的会话
import * as sessionManager from "../services/session";

// 【文件注册表服务】
// 管理文档的全局注册表
import { registerDocument, unregisterDocument, initFileRegistry } from "../services/fileRegistry";

// 【协作状态服务】
// 管理Yjs协作状态的持久化
import { cleanupCollabStates, deleteCollabState, hasCollabState } from "../services/collabStateService";

// ================================================================
// 【路由初始化】
// ================================================================

/**
 * 【创建路由实例】
 * 
 * 【功能说明】
 * 创建Express路由实例
 * 所有文档管理的API端点都挂载到这个路由上
 */
const router: Router = express.Router();

/**
 * 【协作WebSocket地址】
 * 
 * 【功能说明】
 * 从配置中获取协作WebSocket地址
 * 用于返回给前端，让前端连接协作服务
 */
const COLLAB_WS_URL = config.COLLAB_WS_URL;

/**
 * 【原始DOCX Body解析中间件】
 * 
 * 【功能说明】
 * 解析原始DOCX二进制数据
 * 用于保存文档内容的API端点
 * 
 * 【配置】
 * - type: 接受的MIME类型
 * - limit: 大小限制（50MB）
 */
const rawDocxBody = express.raw({
  type: [
    "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  limit: "50mb",
});

// ================================================================
// 【辅助函数】
// ================================================================

/**
 * 【文件名解码】
 * 
 * 【功能说明】
 * 处理前端通过特殊编码方式发送的文件名
 * 支持UTF-8二进制编码
 * 
 * 【两层解码逻辑】
 * 1. 先尝试decodeURIComponent
 * 2. 失败则使用Buffer从binary转utf8
 * 
 * 【为什么需要这个？】
 * 部分中文字符在HTTP header中会因编码不匹配而损坏
 * 
 * @param filename - 原始文件名
 * @returns 解码后的文件名
 */
function decodeFilename(filename: string): string {
  if (!filename) return filename;
  try {
    // 【第一层：decodeURIComponent】
    const decoded = decodeURIComponent(filename);
    if (decoded !== filename) return decoded;
    
    // 【第二层：Buffer转换】
    const buffer = Buffer.from(filename, "binary");
    return buffer.toString("utf8");
  } catch {
    return filename;
  }
}

/**
 * 【获取请求参数中的ID】
 * 
 * 【功能说明】
 * Express 5.x兼容：req.params.id可能返回string | string[]
 * 统一转为string
 * 
 * @param req - 请求对象
 * @returns 文档ID
 */
function getParamId(req: Request): string {
  return String(req.params.id);
}

/**
 * 【为文档元数据附加协作房间信息】
 * 
 * 【功能说明】
 * 前端编辑器需要roomName/wsUrl来连接协作服务
 * 如果metadata中已有roomName则使用已有值，否则用docId作为默认房间名
 * 
 * @param document - 文档元数据
 * @param roomInfo - 房间信息（可选）
 * @returns 包含协作信息的文档数据
 */
function withCollaboration(
  document: DocumentMetadata,
  roomInfo?: { roomName: string; wsUrl: string; hasPersistedState?: boolean },
) {
  const roomName = roomInfo?.roomName || document.roomName || document.id;
  const wsUrl = roomInfo?.wsUrl || COLLAB_WS_URL;

  return {
    ...document,
    roomName,
    collaboration: {
      docId: document.id,
      roomName,
      wsUrl,
      hasPersistedState: Boolean(roomInfo?.hasPersistedState),
    },
  };
}

// ================================================================
// 【API端点】
// ================================================================

/**
 * 【批量清理文档】
 * 
 * 【功能说明】
 * 关闭所有SDK会话后删除磁盘文件
 * keepIds是保留白名单，不在白名单中的文档都会被删除
 * 删除后重新初始化文件注册表
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/docs/cleanup
 * 请求体: { keepIds: string[] }
 * 
 * 【执行流程】
 * 1. 验证keepIds是否为数组
 * 2. 关闭所有会话，释放SDK文件句柄
 * 3. 清理文档文件
 * 4. 清理协作状态
 * 5. 重新扫描uploads目录重建注册表
 * 6. 返回清理结果
 */
router.post("/cleanup", async (req: Request, res: Response) => {
  try {
    const { keepIds } = req.body;
    
    // 【验证参数】
    if (!Array.isArray(keepIds)) {
      return res.status(400).json({ error: "keepIds 必须是数组" });
    }
    
    // 【关闭所有会话】
    // 清理前必须先关闭所有会话，释放SDK文件句柄
    await sessionManager.closeAllSessions("cleanup");
    
    // 【清理文档文件】
    const deleted = await cleanupDocuments(keepIds);
    
    // 【清理协作状态】
    await cleanupCollabStates(keepIds);
    
    // 【重新初始化文件注册表】
    // 重新扫描uploads目录重建注册表，保证后续操作的数据一致性
    await initFileRegistry();
    
    res.json({ success: true, message: "清理完成", deleted: deleted });
  } catch (error) {
    console.error("清理文件失败:", error);
    res.status(500).json({ error: "清理文件失败" });
  }
});

/**
 * 【保存文档内容】
 * 
 * 【功能说明】
 * 保存文档的二进制内容到磁盘
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/docs/:id/save
 * Content-Type: application/octet-stream
 * 请求体: DOCX文件的二进制数据
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 验证请求体是否为Buffer
 * 3. 调用saveDocumentContent保存内容
 * 4. 返回保存结果
 */
router.post("/:id/save", rawDocxBody, async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    
    // 【验证请求体】
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ success: false, error: "缺少文档内容" });
    }

    // 【保存文档内容】
    const result = await saveDocumentContent(id, req.body);
    
    res.json({
      success: true,
      saved: result.saved,
      hash: result.hash,
      document: withCollaboration(result.metadata),
    });
  } catch (error) {
    console.error("保存文档失败:", error);
    res.status(500).json({ success: false, error: "保存文档失败" });
  }
});

/**
 * 【保存会话文档】
 * 
 * 【功能说明】
 * 保存当前会话中的文档状态
 * 用于协作编辑场景
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/docs/:id/save-session
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 创建或使用会话
 * 3. 保存会话文档
 * 4. 获取文档信息
 * 5. 返回保存结果
 */
router.post("/:id/save-session", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    
    // 【创建或使用会话】
    await sessionManager.createOrUseSession(id);
    
    // 【保存会话文档】
    const result = await sessionManager.saveSessionDocument(id);
    
    // 【获取文档信息】
    const document = await getDocumentById(id);

    if (!document) {
      return res.status(404).json({ success: false, error: "文件不存在" });
    }

    res.json({
      success: true,
      saved: result.saved,
      hash: result.hash,
      document: withCollaboration(document),
    });
  } catch (error) {
    console.error("保存协作会话文档失败:", error);
    res.status(500).json({ success: false, error: "保存协作会话文档失败" });
  }
});

// ================================================================
// 【Multer配置】
// ================================================================

/**
 * 【Multer存储配置】
 * 
 * 【功能说明】
 * 使用内存存储避免磁盘临时文件
 * 文件内容通过saveDocument写入uploads
 */
const storage = multer.memoryStorage();

/**
 * 【Multer上传配置】
 * 
 * 【功能说明】
 * 配置文件上传的过滤和限制
 * 
 * 【文件过滤】
 * 只过滤.doc和.docx格式
 * 同时检查MIME类型和扩展名（双重保险）
 * 
 * 【大小限制】
 * 50MB上限，防止单个大文件撑爆内存
 */
const upload = multer({
  storage: storage,
  fileFilter: function (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
    // 【允许的MIME类型】
    const allowedTypes = [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
    ];
    
    // 【允许的扩展名】
    const allowedExtensions = [".docx", ".doc"];

    // 【获取文件扩展名】
    const ext = path.extname(file.originalname).toLowerCase();

    // 【双重校验】
    // MIME类型或扩展名任一匹配即放行
    // 为什么用||：某些浏览器/系统对同一文件类型上报的MIME不一致
    if (allowedTypes.indexOf(file.mimetype) >= 0 || allowedExtensions.indexOf(ext) >= 0) {
      // @ts-ignore
      cb(null, true);
    } else {
      // @ts-ignore
      cb(new Error("只支持 .doc 和 .docx 文件"), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024,  // 50MB上限
  },
});

/**
 * 【上传文档】
 * 
 * 【功能说明】
 * 支持多文件批量上传（最多10个）
 * 
 * 【处理流程】
 * 1. 解码文件名
 * 2. 保存到磁盘 + 生成元数据
 * 3. 注册到文件映射表
 * 4. 返回协作信息
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/docs/upload
 * Content-Type: multipart/form-data
 * 请求体: files字段，包含多个文件
 * 
 * 【注意】
 * 上传不建立协作连接
 * 用户打开文档时前端编辑器才会加载内容到Yjs
 */
router.post(
  "/upload",
  upload.array("files", 10),
  async (req: Request, res: Response) => {
    try {
      // 【验证文件】
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "没有文件被上传" });
      }

      const results = [];

      // 【遍历所有文件】
      for (const file of req.files as Express.Multer.File[]) {
        // 【解码文件名】
        file.originalname = decodeFilename(file.originalname);

        // 【保存文件】
        // 保存文件到uploads目录并持久化元数据（JSON文件）
        const metadata = await saveDocument({
          originalname: file.originalname,
          buffer: file.buffer,
          size: file.size,
          mimetype: file.mimetype,
        });

        // 【注册到文件映射表】
        // 供AI Agent按名称/ID定位文档
        registerDocument(metadata);

        // 【返回包含协作信息的文档数据】
        // 前端可直接用roomName+wsUrl连接
        results.push(
          withCollaboration(metadata, {
            roomName: metadata.id,
            wsUrl: COLLAB_WS_URL,
          })
        );
      }

      res.json({
        success: true,
        message: "成功上传 " + results.length + " 个文件",
        files: results,
      });
    } catch (error: unknown) {
      console.error("上传文件失败:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "上传失败" });
    }
  }
);

/**
 * 【获取文档列表】
 * 
 * 【功能说明】
 * 从uploads目录扫描所有.json元数据文件
 * 返回按上传时间倒序排列的文档列表
 * 每个文档附带协作连接信息
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/docs/list
 * 
 * 【执行流程】
 * 1. 调用getDocumentList获取文档列表
 * 2. 为每个文档附加协作信息
 * 3. 返回文档列表
 */
router.get("/list", async (req: Request, res: Response) => {
  try {
    // 【获取文档列表】
    const documents = await getDocumentList();
    
    // 【附加协作信息】
    const mappedDocuments = documents.map((doc) =>
      withCollaboration(doc, {
        roomName: doc.id,
        wsUrl: COLLAB_WS_URL,
      })
    );

    res.json({
      success: true,
      documents: mappedDocuments,
      total: mappedDocuments.length,
    });
  } catch (error) {
    console.error("获取文件列表失败:", error);
    res.status(500).json({ error: "获取文件列表失败" });
  }
});

/**
 * 【打开文档】
 * 
 * 【功能说明】
 * 前端请求打开某个文档时调用
 * 后端通过sessionManager.ensureYjsRoom返回房间信息
 * 前端拿到roomName/wsUrl后自行连接y-websocket协作服务
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/docs/:id/open
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 获取文档信息
 * 3. 确保Yjs房间存在
 * 4. 检查是否有持久化状态
 * 5. 返回文档信息和协作信息
 * 
 * 【注意】
 * 后端不在此处播种Y.Doc内容
 * 播种由前端完成（调用/:id/seed获取原始文件）
 */
router.post("/:id/open", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    
    // 【获取文档信息】
    const document = await getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    // 【确保Yjs房间存在】
    const roomInfo = await sessionManager.ensureYjsRoom(id);
    
    // 【检查是否有持久化状态】
    const hasPersistedState = await hasCollabState(roomInfo.roomName);

    res.json({
      success: true,
      document: withCollaboration(document, { ...roomInfo, hasPersistedState }),
      backend: {
        httpBaseUrl: "http://localhost:" + config.PORT,
      },
    });
  } catch (error) {
    console.error("打开文档失败:", error);
    res.status(500).json({ error: "打开文档失败" });
  }
});

/**
 * 【获取种子文件】
 * 
 * 【功能说明】
 * 返回原始DOCX文件供前端播种到Yjs房间
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/docs/:id/seed
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 获取文档文件
 * 3. 设置响应头
 * 4. 发送文件
 * 
 * 【注意】
 * 不要在发送后删除磁盘文件
 * 页面刷新、浏览器重开或协作服务重启后
 * 前端仍需要这个DOCX作为重新进入协作房间的种子数据
 */
router.get("/:id/seed", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    
    // 【获取文档文件】
    const result = await getDocumentFile(id);

    if (!result) {
      return res.status(404).json({ error: "文件不存在" });
    }

    const { filePath, metadata } = result;

    // 【设置响应头】
    // 设置正确的MIME类型和下载文件名
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      ttachment; filename=""
    );

    // 【发送文件】
    res.sendFile(filePath);
  } catch (error) {
    console.error("获取种子文件失败:", error);
    res.status(500).json({ error: "获取种子文件失败" });
  }
});

/**
 * 【获取文档信息】
 * 
 * 【功能说明】
 * 查询单个文档的元数据（不涉及文件内容）
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/docs/:id/info
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 获取文档信息
 * 3. 附加协作信息
 * 4. 返回文档信息
 */
router.get("/:id/info", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    
    // 【获取文档信息】
    const document = await getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    res.json({
      success: true,
      document: withCollaboration(document, {
        roomName: document.id,
        wsUrl: COLLAB_WS_URL,
      }),
    });
  } catch (error) {
    console.error("获取文件信息失败:", error);
    res.status(500).json({ error: "获取文件信息失败" });
  }
});

/**
 * 【删除文档】
 * 
 * 【功能说明】
 * 顺序执行：关闭SDK会话 → 从注册表注销 → 删除磁盘文件
 * 
 * 【HTTP请求】
 * 方法: DELETE
 * 端点: /api/docs/:id
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 获取文档信息
 * 3. 关闭SDK会话（必须先释放句柄再删文件）
 * 4. 删除协作状态
 * 5. 从全局注册表移除
 * 6. 删除磁盘文件
 * 7. 返回删除结果
 * 
 * 【为什么先关闭会话再删文件？】
 * 防止SDK持有已删除文件的句柄导致错误
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    
    // 【获取文档信息】
    const document = await getDocumentById(id);

    // 【关闭SDK会话】
    // 必须先释放句柄再删文件
    await sessionManager.closeSessionByDocId(id, "delete");
    
    // 【删除协作状态】
    if (document) {
      await deleteCollabState(document.roomName || document.id);
    }

    // 【从全局注册表移除】
    // 防止Agent引用已不存在的文档
    unregisterDocument(id);

    // 【删除磁盘文件】
    const success = await deleteDocument(id);

    if (!success) {
      return res.status(404).json({ error: "文件不存在" });
    }

    res.json({
      success: true,
      message: "文件删除成功",
    });
  } catch (error) {
    console.error("删除文件失败:", error);
    res.status(500).json({ error: "删除文件失败" });
  }
});

// ================================================================
// 【导出】
// ================================================================

/**
 * 【导出路由实例】
 * 
 * 【功能说明】
 * 导出配置好的路由实例
 * 供server.ts挂载到Express应用上
 */
export default router;
