const express = require("express");
const multer = require("multer");
const path = require("path");
const config = require("../config");

function decodeFilename(filename) {
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

const {
  saveDocument,
  getDocumentList,
  getDocumentFile,
  getDocumentById,
  deleteDocument,
  cleanupDocuments,
  createSSEHandler,
  emitFileDeleted,
} = require("../services/docServices");

const router = express.Router();
const DEFAULT_HOCUSPOCUS_URL = config.HOCUSPOCUS_URL;

router.get("/events", createSSEHandler);

const sessionManager = require("../services/session");

function withCollaboration(document, roomInfo) {
  const roomName = roomInfo?.roomName || document.roomName || document.id;
  const wsUrl = roomInfo?.wsUrl || DEFAULT_HOCUSPOCUS_URL;

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

router.post("/cleanup", async (req, res) => {
  try {
    const { keepIds } = req.body;
    if (!Array.isArray(keepIds)) {
      return res.status(400).json({ error: "keepIds 必须是数组" });
    }
    // 先保存所有会话
    await sessionManager.closeAllSessions();
    // 再清理文件
    const deleted = cleanupDocuments(keepIds);
    res.json({ success: true, message: "清理完成", deleted });
  } catch (error) {
    console.error("清理文件失败:", error);
    res.status(500).json({ error: "清理文件失败" });
  }
});

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
  ];
  const allowedExtensions = [".docx", ".doc"];

  const ext = path.extname(file.originalname).toLowerCase();
  console.log("fileFilter: ext=", ext);

  if (
    allowedTypes.includes(file.mimetype) ||
    allowedExtensions.includes(ext)
  ) {
    cb(null, true);
  } else {
    cb(new Error("只支持 .doc 和 .docx 文件"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

router.post("/upload", upload.array("files", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "没有文件被上传" });
    }

    req.files.forEach((file) => {
      const decodedName = decodeFilename(file.originalname);
      file.originalname = decodedName;
    });

    const results = await Promise.all(
      req.files.map(async (file) => {
        const metadata = saveDocument(file);
        const roomInfo = await sessionManager.ensureYjsRoom(metadata.id);
        return withCollaboration(metadata, roomInfo);
      })
    );

    res.json({
      success: true,
      message: `成功上传 ${results.length} 个文件`,
      files: results,
    });
  } catch (error) {
    console.error("上传文件失败:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/list", async (req, res) => {
  try {
    const documents = getDocumentList();
    const mappedDocuments = documents.map((doc) => {
      const roomInfo = sessionManager.getRoomInfoByDocId(doc.id);
      return withCollaboration(doc, roomInfo);
    });

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

router.post("/:id/open", async (req, res) => {
  try {
    const { id } = req.params;
    const document = getDocumentById(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    const roomInfo = await sessionManager.ensureYjsRoom(id);

    res.json({
      success: true,
      document: withCollaboration(document, roomInfo),
      backend: {
        httpBaseUrl: `http://localhost:${config.PORT}`,
      },
    });
  } catch (error) {
    console.error("打开文档失败:", error);
    res.status(500).json({ error: "打开文档失败" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 确保 Yjs Room 已就绪（创建 SDK session 供 Hocuspocus 共享使用）
    await sessionManager.ensureYjsRoom(id);

    const result = getDocumentFile(id);

    if (!result) {
      return res.status(404).json({ error: "文件不存在" });
    }

    const { path: filePath, metadata } = result;

    res.setHeader(
      "Content-Type",
      metadata.mimeType ||
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(metadata.originalName)}"`
    );

    res.sendFile(filePath);
  } catch (error) {
    console.error("下载文件失败:", error);
    res.status(500).json({ error: "下载文件失败" });
  }
});

router.get("/:id/info", async (req, res) => {
  try {
    const { id } = req.params;
    const file = getDocumentFile(id);

    if (!file) {
      return res.status(404).json({ error: "文件不存在" });
    }

    const roomInfo = sessionManager.getRoomInfoByDocId(id);

    res.json({
      success: true,
      document: withCollaboration(file.metadata, roomInfo),
    });
  } catch (error) {
    console.error("获取文件信息失败:", error);
    res.status(500).json({ error: "获取文件信息失败" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = getDocumentById(id);

    await sessionManager.closeSessionByDocId(id);
    sessionManager.removeRoomByDocId(id);

    const success = deleteDocument(id);

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

module.exports = router;
