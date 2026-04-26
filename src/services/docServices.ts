import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";

export const UPLOAD_DIR = path.join(__dirname, "../../uploads");

export const docEmitter = new EventEmitter();
docEmitter.setMaxListeners(100);

function ensureUploadDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function generateFileId(): string {
  return uuidv4();
}

export interface DocumentMetadata {
  id: string;
  roomName: string;
  originalName: string;
  storedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  filePath: string;
}

export function saveDocument(file: {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}): DocumentMetadata {
  ensureUploadDir();

  const fileId = generateFileId();
  const ext = path.extname(file.originalname);
  const storedFilename = `${fileId}${ext}`;
  const filePath = path.join(UPLOAD_DIR, storedFilename);

  console.log("saveDocument 收到文件名:", file.originalname);
  fs.writeFileSync(filePath, file.buffer);

  const metadata: DocumentMetadata = {
    id: fileId,
    roomName: fileId,
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

export function updateDocument(
  id: string,
  fileBuffer: Buffer
): DocumentMetadata | null {
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

export interface SSEventSource {
  setHeader(key: string, value: string): void;
  flushHeaders(): void;
  write(data: string): void;
  end(): void;
}

export function createSSEHandler(req: { on: (event: string, cb: () => void) => void }, res: SSEventSource): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const onFileUpdated = (data: { fileId: string; fileName: string }) => {
    res.write(`event: file_updated\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onFileDeleted = (data: { fileId: string; fileName: string }) => {
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

export function emitFileDeleted(data: { fileId: string; fileName: string }): void {
  docEmitter.emit("file_deleted", data);
}

export function getDocumentList(): DocumentMetadata[] {
  ensureUploadDir();

  const files = fs.readdirSync(UPLOAD_DIR);
  const metadataFiles = files.filter((f) => f.endsWith(".json"));

  const documents = metadataFiles
    .map((f) => {
      try {
        const content = fs.readFileSync(path.join(UPLOAD_DIR, f), "utf-8");
        const doc = JSON.parse(content) as DocumentMetadata;
        if (!doc.roomName) {
          doc.roomName = doc.id;
        }
        return doc;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as DocumentMetadata[];

  return documents.sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
}

export function getDocumentById(id: string): DocumentMetadata | null {
  const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);

  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(metadataPath, "utf-8");
    const doc = JSON.parse(content) as DocumentMetadata;
    if (!doc.roomName) {
      doc.roomName = doc.id;
    }
    return doc;
  } catch {
    return null;
  }
}

export function getDocumentFile(
  id: string
): { path: string; metadata: DocumentMetadata } | null {
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

export function deleteDocument(id: string): boolean {
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

export function cleanupDocuments(keepIds: string[]): number {
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