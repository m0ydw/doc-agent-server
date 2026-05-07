import express, { Request, Response, Router } from "express";
import multer, { FileFilterCallback } from "multer";
import path from "path";
import fs from "fs/promises";
import config from "../config";
import {
  saveDocument,
  getDocumentList,
  getDocumentFile,
  getDocumentById,
  deleteDocument,
  cleanupDocuments,
  DocumentMetadata,
} from "../services/docServices";
import * as sessionManager from "../services/session";
import { registerDocument, unregisterDocument } from "../services/fileRegistry";

const router: Router = express.Router();
const COLLAB_WS_URL = config.COLLAB_WS_URL;

// ===== 文件名解码 =====
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

// ===== 辅助函数 =====

/** Express 5.x 中 req.params.id 可能返回 string | string[] */
function getParamId(req: Request): string {
  return String(req.params.id);
}

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

// ===== 路由 =====

/**
 * 清理文档
 */
router.post("/cleanup", async (req: Request, res: Response) => {
  try {
    const { keepIds } = req.body;
    if (!Array.isArray(keepIds)) {
      return res.status(400).json({ error: "keepIds 必须是数组" });
    }
    // 关闭所有 SDK 会话
    await sessionManager.closeAllSessions();
    // 清理磁盘文件
    const deleted = await cleanupDocuments(keepIds);
    // 重新初始化文件映射表（cleanup 后重新扫描）
    const { initFileRegistry } = await import("../services/fileRegistry");
    initFileRegistry();
    res.json({ success: true, message: "清理完成", deleted: deleted });
  } catch (error) {
    console.error("清理文件失败:", error);
    res.status(500).json({ error: "清理文件失败" });
  }
});

// ===== Multer 配置 =====
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
    console.log("fileFilter: ext=", ext);

    if (allowedTypes.indexOf(file.mimetype) >= 0 || allowedExtensions.indexOf(ext) >= 0) {
      // multer 2.x FileFilterCallback 类型定义不兼容
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      cb(null, true);
    } else {
      // @ts-ignore
      cb(new Error("只支持 .doc 和 .docx 文件"), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

/**
 * 上传文档（只保存到磁盘，不连接协作）
 * 用户打开文档时，前端编辑器会自动加载内容到 Yjs
 */
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
        // 解码文件名
        file.originalname = decodeFilename(file.originalname);

        // 1. 保存文件到磁盘
        const metadata = await saveDocument({
          originalname: file.originalname,
          buffer: file.buffer,
          size: file.size,
          mimetype: file.mimetype,
        });

        // 2. 注册到文件映射表
        registerDocument(metadata);

        // 3. 保留文件，前端打开时会加载内容到 Yjs
        // 不需要清理，文件存放在 UPLOAD_DIR

        // 返回协作信息
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
 * 获取文档列表
 */
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

/**
 * 打开文档（加入协作房间）
 * 前端负责播种 Y.Doc，后端仅返回房间信息
 */
router.post("/:id/open", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    const document = await getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    // 返回 Yjs 协作房间信息（不调 SDK，前端负责播种）
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

/**
 * 获取文件原始内容（供前端播种用），发送完成后删除磁盘文件
 */
router.get("/:id/seed", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    const result = await getDocumentFile(id);

    if (!result) {
      return res.status(404).json({ error: "文件不存在" });
    }

    const { filePath, metadata } = result;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(metadata.originalName)}"`
    );

    // 发送完成后删除磁盘文件（Yjs 协作模式已持有完整内容）
    res.sendFile(filePath, () => {
      fs.unlink(filePath).catch(() => {});
    });
  } catch (error) {
    console.error("获取种子文件失败:", error);
    res.status(500).json({ error: "获取种子文件失败" });
  }
});

/**
 * 获取文档信息
 */
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

/**
 * 删除文档
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = getParamId(req);
    const document = await getDocumentById(id);

    // 关闭 SDK 会话
    await sessionManager.closeSessionByDocId(id);

    // 从文件映射表注销
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