const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { EventEmitter } = require("events");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");

const docEmitter = new EventEmitter();
docEmitter.setMaxListeners(100);

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function generateFileId() {
  return uuidv4();
}

function saveDocument(file) {
  ensureUploadDir();

  const fileId = generateFileId();
  const ext = path.extname(file.originalname);
  const storedFilename = `${fileId}${ext}`;
  const filePath = path.join(UPLOAD_DIR, storedFilename);

  fs.writeFileSync(filePath, file.buffer);

  const metadata = {
    id: fileId,
    originalName: file.originalname,
    storedName: storedFilename,
    size: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date().toISOString(),
    filePath: `/uploads/${storedFilename}`,
  };

  const metadataPath = path.join(UPLOAD_DIR, `${fileId}.json`);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return metadata;
}

function updateDocument(id, fileBuffer) {
  const metadata = getDocumentById(id);
  if (!metadata) {
    return null;
  }

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  fs.writeFileSync(filePath, fileBuffer);

  metadata.uploadedAt = new Date().toISOString();
  const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  docEmitter.emit("file_updated", { fileId: id, fileName: metadata.originalName });

  return metadata;
}

function createSSEHandler(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const onFileUpdated = (data) => {
    res.write(`event: file_updated\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onFileDeleted = (data) => {
    res.write(`event: file_deleted\ndata: ${JSON.stringify(data)}\n\n`);
  };

  docEmitter.on("file_updated", onFileUpdated);
  docEmitter.on("file_deleted", onFileDeleted);

  req.on("close", () => {
    docEmitter.off("file_updated", onFileUpdated);
    docEmitter.off("file_deleted", onFileDeleted);
    res.end();
  });
}

function emitFileDeleted(data) {
  docEmitter.emit("file_deleted", data);
}

function getDocumentList() {
  ensureUploadDir();

  const files = fs.readdirSync(UPLOAD_DIR);
  const metadataFiles = files.filter((f) => f.endsWith(".json"));

  const documents = metadataFiles
    .map((f) => {
      try {
        const content = fs.readFileSync(path.join(UPLOAD_DIR, f), "utf-8");
        return JSON.parse(content);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return documents.sort(
    (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
  );
}

function getDocumentById(id) {
  const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);

  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(metadataPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getDocumentFile(id) {
  const metadata = getDocumentById(id);

  if (!metadata) {
    return null;
  }

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    path: filePath,
    metadata,
  };
}

function deleteDocument(id) {
  const metadata = getDocumentById(id);

  if (!metadata) {
    return false;
  }

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  if (fs.existsSync(metadataPath)) {
    fs.unlinkSync(metadataPath);
  }

  return true;
}

function cleanupDocuments(keepIds) {
  const allDocs = getDocumentList();
  let deletedCount = 0;

  for (const doc of allDocs) {
    if (!keepIds.includes(doc.id)) {
      const filePath = path.join(UPLOAD_DIR, doc.storedName);
      const metadataPath = path.join(UPLOAD_DIR, `${doc.id}.json`);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
      }
      deletedCount++;
      console.log(`清理文件: ${doc.originalName} (${doc.id})`);
    }
  }

  return deletedCount;
}

module.exports = {
  saveDocument,
  getDocumentList,
  getDocumentById,
  getDocumentFile,
  deleteDocument,
  cleanupDocuments,
  createSSEHandler,
  emitFileDeleted,
  docEmitter,
  UPLOAD_DIR,
};
