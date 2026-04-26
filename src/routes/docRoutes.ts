import express, { Request, Response, Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
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

const router: Router = express.Router();
const HOCUSPOCUS_URL = config.HOCUSPOCUS_URL;

// ===== 文件名解码 =====
function decodeFilename(filename: string): string {
  if (!filename) return filename;
  try {
    var decoded = decodeURIComponent(filename);
    if (decoded !== filename) return decoded;
    var buffer = Buffer.from(filename, "binary");
    return buffer.toString("utf8");
  } catch {
    return filename;
  }
}

// ===== 辅助函数 =====

function withCollaboration(document: DocumentMetadata, roomInfo?: { roomName: string; wsUrl: string }) {
  const roomName = roomInfo?.roomName || document.roomName || document.id;
  const wsUrl = roomInfo?.wsUrl || HOCUSPOCUS_URL;

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
    var deleted = cleanupDocuments(keepIds);
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
  fileFilter: function (_req, file, cb) {
    var allowedTypes = [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
    ];
    var allowedExtensions = [".docx", ".doc"];

    var ext = path.extname(file.originalname).toLowerCase();
    console.log("fileFilter: ext=", ext);

    if (allowedTypes.indexOf(file.mimetype) >= 0 || allowedExtensions.indexOf(ext) >= 0) {
      (cb as any)(null, true);
    } else {
      (cb as any)(new Error("只支持 .doc 和 .docx 文件"), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

/**
 * 上传文档并播种到 Yjs 协作房间
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

      for (const file of req.files as any[]) {
        // 解码文件名
        file.originalname = decodeFilename(file.originalname);

        // 1. 保存临时种子文件，saveDocument 会生成 fileId 并存储
        const metadata = saveDocument({
          originalname: file.originalname,
          buffer: file.buffer,
          size: file.size,
          mimetype: file.mimetype,
        });

        // 临时文件路径
        const tempFilePath = path.join(
          __dirname,
          "../../uploads",
          metadata.storedName
        );

        try {
          // 2. 使用 SDK 将种子文件播种到 Yjs 房间
          console.log(`[DocRoutes] 播种种子文件: ${metadata.id}`);
          await sessionManager.createOrUseSessionWithSeed(metadata.id, tempFilePath);
        } finally {
          // 3. 无论播种成功与否，清理临时文件
          // 但保留元数据文件（.json），删除 .docx 临时文件
          try {
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
              console.log(`[DocRoutes] 已清理临时文件: ${tempFilePath}`);
            }
          } catch (cleanupError) {
            console.warn("[DocRoutes] 临时文件清理失败:", (cleanupError as Error).message);
          }
        }

        // 返回协作信息
        results.push(
          withCollaboration(metadata, {
            roomName: metadata.id,
            wsUrl: HOCUSPOCUS_URL,
          })
        );
      }

      res.json({
        success: true,
        message: "成功上传 " + results.length + " 个文件",
        files: results,
      });
    } catch (error) {
      console.error("上传文件失败:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * 获取文档列表
 */
router.get("/list", async (req: Request, res: Response) => {
  try {
    const documents = getDocumentList();
    const mappedDocuments = documents.map((doc) =>
      withCollaboration(doc, {
        roomName: doc.id,
        wsUrl: HOCUSPOCUS_URL,
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
 */
router.post("/:id/open", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const document = getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    // 加入 Yjs 协作房间
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
 * 下载文档（如果磁盘文件还存在）
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    // 加入协作房间
    await sessionManager.ensureYjsRoom(id);

    const result = getDocumentFile(id);

    if (!result) {
      // 文档可能只有 Yjs 状态，没有磁盘文件
      return res.status(404).json({ error: "文件不存在或已被清理" });
    }

    const filePath = result.path;
    const metadata = result.metadata;

    res.setHeader(
      "Content-Type",
      metadata.mimeType ||
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=\"" + encodeURIComponent(metadata.originalName) + "\""
    );

    res.sendFile(filePath);
  } catch (error) {
    console.error("下载文件失败:", error);
    res.status(500).json({ error: "下载文件失败" });
  }
});

/**
 * 获取文档信息
 */
router.get("/:id/info", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const document = getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    res.json({
      success: true,
      document: withCollaboration(document, {
        roomName: document.id,
        wsUrl: HOCUSPOCUS_URL,
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
    const id = req.params.id;
    const document = getDocumentById(id);

    // 关闭 SDK 会话
    await sessionManager.closeSessionByDocId(id);

    const success = deleteDocument(id);

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