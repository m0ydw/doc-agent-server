const express = require("express");
const multer = require("multer");
const path = require("path");
const {
  saveDocument,
  getDocumentList,
  getDocumentFile,
  deleteDocument,
  createSSEHandler,
} = require("../services/docServices");

const router = express.Router();

router.get("/events", createSSEHandler);

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
  ];
  const allowedExtensions = [".docx", ".doc"];

  const ext = path.extname(file.originalname).toLowerCase();

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
      console.log("收到文件:", {
        originalName: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        encoding: file.encoding,
      });
    });

    const results = req.files.map((file) => saveDocument(file));

    res.json({
      success: true,
      message: `成功上传 ${results.length} 个文件`,
      files: results,
    });
  } catch (error) {
    console.error("上传文件失败:", error);
    res.status(500).json({ error: error.message || "上传文件失败" });
  }
});

router.get("/list", async (req, res) => {
  try {
    const documents = getDocumentList();
    res.json({
      success: true,
      documents,
      total: documents.length,
    });
  } catch (error) {
    console.error("获取文件列表失败:", error);
    res.status(500).json({ error: "获取文件列表失败" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
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
    const document = getDocumentFile(id);

    if (!document) {
      return res.status(404).json({ error: "文件不存在" });
    }

    res.json({
      success: true,
      document: document.metadata,
    });
  } catch (error) {
    console.error("获取文件信息失败:", error);
    res.status(500).json({ error: "获取文件信息失败" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
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

module.exports = router;
