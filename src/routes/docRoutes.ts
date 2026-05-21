// 文档管理路由 — 负责文件上传/列表/打开/种子/信息/删除/清理
// 上传流程：multer 解析 → 解码文件名 → 保存磁盘 + 元数据 → 注册到文件映射表 → 返回协作信息
// 设计原则：上传只存盘不连接协作（延迟加载），用户打开时才建立 Yjs 房间连接

import express, { Request, Response, Router } from "express";
import multer, { FileFilterCallback } from "multer";
import path from "path";
import config from "../config";
import {
  saveDocument,
  getDocumentList,
  getDocumentFile,
  getDocumentById,
  deleteDocument,
  cleanupDocuments,
  saveDocumentContent,
  DocumentMetadata,
} from "../services/docServices";
import * as sessionManager from "../services/session";
import { registerDocument, unregisterDocument } from "../services/fileRegistry";

const router: Router = express.Router();
const COLLAB_WS_URL = config.COLLAB_WS_URL;
const rawDocxBody = express.raw({
  type: [
    "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  limit: "50mb",
});

// 文件名解码 — 处理前端通过特殊编码方式发送的文件名（如 UTF-8 二进制编码）
// 两层解码逻辑：先尝试 decodeURIComponent，失败则使用 Buffer 从 binary 转 utf8
// 为什么需要这个：部分中文字符在 HTTP header 中会因编码不匹配而损坏
function decodeFilename(filename: string): string {
  if (!filename) return filename;
  try {
    const decoded = decodeURIComponent(filename);
    if (decoded !== filename) return decoded;
    const buffer = Buffer.from(filename, "binary");
    return buffer.toString("utf8");
  } catch {
    return filename;
  }
}

// Express 5.x 兼容：req.params.id 可能返回 string | string[]，统一转为 string
function getParamId(req: Request): string {
  return String(req.params.id);
}

// 为文档元数据附加协作房间信息 — 前端编辑器需要 roomName/wsUrl 来连接协作服务
// 如果 metadata 中已有 roomName 则使用已有值，否则用 docId 作为默认房间名
function withCollaboration(document: DocumentMetadata, roomInfo?: { roomName: string; wsUrl: string }) {
  const roomName = roomInfo?.roomName || document.roomName || document.id;
  const wsUrl = roomInfo?.wsUrl || COLLAB_WS_URL;

  return {
    ...document,
    roomName,
    collaboration: {
      docId: document.id,
      roomName,
      wsUrl,
    },
  };
}

// 批量清理文档 — 关闭所有 SDK 会话后删除磁盘文件
// keepIds 是保留白名单，不在白名单中的文档都会被删除
// 删除后重新初始化文件注册表，确保注册表与实际文件一致
router.post("/cleanup", async (req: Request, res: Response) => {
  try {
    const { keepIds } = req.body;
    if (!Array.isArray(keepIds)) {
      return res.status(400).json({ error: "keepIds 必须是数组" });
    }
    // 清理前必须先关闭所有会话，释放 SDK 文件句柄
    await sessionManager.closeAllSessions();
    const deleted = await cleanupDocuments(keepIds);
    // 重新扫描 uploads 目录重建注册表，保证后续操作的数据一致性
    const { initFileRegistry } = await import("../services/fileRegistry");
    initFileRegistry();
    res.json({ success: true, message: "清理完成", deleted: deleted });
  } catch (error) {
    console.error("清理文件失败:", error);
    res.status(500).json({ error: "清理文件失败" });
  }
});

router.post("/:id/save", rawDocxBody, async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ success: false, error: "缺少文档内容" });
    }

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

// multer 配置 — 使用内存存储避免磁盘临时文件，文件内容通过 saveDocument 写入 uploads
// 只过滤 .doc 和 .docx 格式（同时检查 MIME 类型和扩展名，双重保险）
// 文件大小限制 50MB，防止单个大文件撑爆内存
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  fileFilter: function (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
    const allowedTypes = [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
    ];
    const allowedExtensions = [".docx", ".doc"];

    const ext = path.extname(file.originalname).toLowerCase();

    // 双重校验：MIME 类型或扩展名任一匹配即放行
    // 为什么用 ||：某些浏览器/系统对同一文件类型上报的 MIME 不一致
    if (allowedTypes.indexOf(file.mimetype) >= 0 || allowedExtensions.indexOf(ext) >= 0) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      cb(null, true);
    } else {
      // @ts-ignore
      cb(new Error("只支持 .doc 和 .docx 文件"), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024,  // 50MB 上限
  },
});

// 上传文档 — 支持多文件批量上传（最多 10 个）
// 处理流程：解码文件名 → 保存到磁盘 + 生成元数据 → 注册到文件映射表 → 返回协作信息
// 注意：上传不建立协作连接，用户打开文档时前端编辑器才会加载内容到 Yjs
router.post(
  "/upload",
  upload.array("files", 10),
  async (req: Request, res: Response) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "没有文件被上传" });
      }

      const results = [];

      for (const file of req.files as Express.Multer.File[]) {
        // 解码文件名以支持中文字符
        file.originalname = decodeFilename(file.originalname);

        // 保存文件到 uploads 目录并持久化元数据（JSON 文件）
        const metadata = await saveDocument({
          originalname: file.originalname,
          buffer: file.buffer,
          size: file.size,
          mimetype: file.mimetype,
        });

        // 注册到全局文件映射表，供 AI Agent 按名称/ID 定位文档
        registerDocument(metadata);

        // 返回包含协作信息的文档数据，前端可直接用 roomName+wsUrl 连接
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

// 获取文档列表 — 从 uploads 目录扫描所有 .json 元数据文件
// 返回按上传时间倒序排列的文档列表，每个文档附带协作连接信息
router.get("/list", async (req: Request, res: Response) => {
  try {
    const documents = await getDocumentList();
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

// 打开文档 — 前端请求打开某个文档时调用
// 后端通过 sessionManager.ensureYjsRoom 返回房间信息
// 前端拿到 roomName/wsUrl 后自行连接 y-websocket 协作服务
// 注意：后端不在此处播种 Y.Doc 内容，播种由前端完成（调用 /:id/seed 获取原始文件）
router.post("/:id/open", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    const document = await getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    const roomInfo = await sessionManager.ensureYjsRoom(id);

    res.json({
      success: true,
      document: withCollaboration(document, roomInfo),
      backend: {
        httpBaseUrl: "http://localhost:" + config.PORT,
      },
    });
  } catch (error) {
    console.error("打开文档失败:", error);
    res.status(500).json({ error: "打开文档失败" });
  }
});

// 获取种子文件 — 返回原始 DOCX 文件供前端播种到 Yjs 房间
// 注意：不要在发送后删除磁盘文件。页面刷新、浏览器重开或协作服务重启后，
// 前端仍需要这个 DOCX 作为重新进入协作房间的种子数据。
router.get("/:id/seed", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    const result = await getDocumentFile(id);

    if (!result) {
      return res.status(404).json({ error: "文件不存在" });
    }

    const { filePath, metadata } = result;

    // 设置正确的 MIME 类型和下载文件名
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(metadata.originalName)}"`
    );

    res.sendFile(filePath);
  } catch (error) {
    console.error("获取种子文件失败:", error);
    res.status(500).json({ error: "获取种子文件失败" });
  }
});

// 获取文档信息 — 查询单个文档的元数据（不涉及文件内容）
router.get("/:id/info", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
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

// 删除文档 — 顺序执行：关闭 SDK 会话 → 从注册表注销 → 删除磁盘文件
// 先关闭会话再删文件是必要的，防止 SDK 持有已删除文件的句柄导致错误
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    const document = await getDocumentById(id);

    // 关闭 SDK 会话 — 必须先释放句柄再删文件
    await sessionManager.closeSessionByDocId(id);

    // 从全局注册表移除，防止 Agent 引用已不存在的文档
    unregisterDocument(id);

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

export default router;
