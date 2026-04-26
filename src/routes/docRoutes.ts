import express, { Request, Response, Router } from "express";
import multer from "multer";
import path from "path";
import config from "../config";

import {
  saveDocument,
  getDocumentList,
  getDocumentFile,
  getDocumentById,
  deleteDocument,
  cleanupDocuments,
  createSSEHandler,
  emitFileDeleted,
  DocumentMetadata,
} from "../services/docServices";

import * as sessionManager from "../services/session";

const router: Router = express.Router();
const DEFAULT_HOCUSPOCUS_URL = config.HOCUSPOCUS_URL;

router.get("/events", (req: Request, res: Response) => {
  createSSEHandler(req as any, res as any);
});

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

function withCollaboration(
  document: DocumentMetadata,
  roomInfo: any
) {
  const roomName = roomInfo ? roomInfo.roomName : (document.roomName || document.id);
  const wsUrl = roomInfo ? roomInfo.wsUrl : DEFAULT_HOCUSPOCUS_URL;

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

router.post("/cleanup", async (req: Request, res: Response) => {
  try {
    const { keepIds } = req.body;
    if (!Array.isArray(keepIds)) {
      return res.status(400).json({ error: "keepIds 必须是数组" });
    }
    await sessionManager.closeAllSessions();
    var deleted = cleanupDocuments(keepIds);
    res.json({ success: true, message: "清理完成", deleted: deleted });
  } catch (error) {
    console.error("清理文件失败:", error);
    res.status(500).json({ error: "清理文件失败" });
  }
});

const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  fileFilter: function(_req, file, cb) {
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

router.post(
  "/upload",
  upload.array("files", 10),
  async (req: Request, res: Response) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "没有文件被上传" });
      }

      var files = req.files as any[];
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        var decodedName = decodeFilename(file.originalname);
        file.originalname = decodedName;
      }

      var results = [];
      for (var j = 0; j < files.length; j++) {
        var f = files[j];
        var metadata = saveDocument(f);
        var roomInfo = await sessionManager.ensureYjsRoom(metadata.id);
        results.push(withCollaboration(metadata, roomInfo));
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

router.get("/list", async (req: Request, res: Response) => {
  try {
    var documents = getDocumentList();
    var mappedDocuments = [];
    for (var i = 0; i < documents.length; i++) {
      var doc = documents[i];
      var roomInfo = sessionManager.getRoomInfoByDocId(doc.id);
      mappedDocuments.push(withCollaboration(doc, roomInfo));
    }

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

router.post("/:id/open", async (req: Request, res: Response) => {
  try {
    var id = req.params.id;
    var document = getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    var roomInfo = await sessionManager.ensureYjsRoom(id);

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

router.get("/:id", async (req: Request, res: Response) => {
  try {
    var id = req.params.id;

    await sessionManager.ensureYjsRoom(id);

    var result = getDocumentFile(id);

    if (!result) {
      return res.status(404).json({ error: "文件不存在" });
    }

    var filePath = result.path;
    var metadata = result.metadata;

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

router.get("/:id/info", async (req: Request, res: Response) => {
  try {
    var id = req.params.id;
    var file = getDocumentFile(id);

    if (!file) {
      return res.status(404).json({ error: "文件不存在" });
    }

    var roomInfo = sessionManager.getRoomInfoByDocId(id);

    res.json({
      success: true,
      document: withCollaboration(file.metadata, roomInfo),
    });
  } catch (error) {
    console.error("获取文件信息失败:", error);
    res.status(500).json({ error: "获取文件信息失败" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    var id = req.params.id;
    var doc = getDocumentById(id);

    await sessionManager.closeSessionByDocId(id);
    sessionManager.removeRoomByDocId(id);

    var success = deleteDocument(id);

    if (!success) {
      return res.status(404).json({ error: "文件不存在" });
    }

    if (doc) {
      emitFileDeleted({ fileId: id, fileName: doc.originalName });
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