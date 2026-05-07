import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export const UPLOAD_DIR = path.join(__dirname, "../../uploads");

// ================================================================
// 目录辅助（同步 - 只在启动和初始化时调用，不影响事件循环）
// ================================================================

function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function generateFileId(): string {
  return uuidv4();
}

// ================================================================
// 文档元数据
// ================================================================

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

// ================================================================
// 基础文件服务（全部异步）
// ================================================================

export async function saveDocument(file: {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}): Promise<DocumentMetadata> {
  ensureUploadDir();

  const fileId = generateFileId();
  const ext = path.extname(file.originalname);
  const storedFilename = `${fileId}${ext}`;
  const filePath = path.join(UPLOAD_DIR, storedFilename);

  console.log("saveDocument 收到文件名:", file.originalname);
  await fs.writeFile(filePath, file.buffer);

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
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return metadata;
}

export async function getDocumentList(): Promise<DocumentMetadata[]> {
  ensureUploadDir();

  const files = await fs.readdir(UPLOAD_DIR);
  const metadataFiles = files.filter((f) => f.endsWith(".json"));

  const documents: DocumentMetadata[] = [];
  for (const f of metadataFiles) {
    try {
      const content = await fs.readFile(path.join(UPLOAD_DIR, f), "utf-8");
      const doc = JSON.parse(content) as DocumentMetadata;
      if (!doc.roomName) doc.roomName = doc.id;
      documents.push(doc);
    } catch {
      // 忽略损坏的元数据文件
    }
  }

  return documents.sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
}

export async function getDocumentById(id: string): Promise<DocumentMetadata | null> {
  const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);

  try {
    await fs.access(metadataPath);
    const content = await fs.readFile(metadataPath, "utf-8");
    const doc = JSON.parse(content) as DocumentMetadata;
    if (!doc.roomName) doc.roomName = doc.id;
    return doc;
  } catch {
    return null;
  }
}

export async function getDocumentFile(
  id: string
): Promise<{ filePath: string; metadata: DocumentMetadata } | null> {
  const metadata = await getDocumentById(id);
  if (!metadata) return null;

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  try {
    await fs.access(filePath);
    return { filePath, metadata };
  } catch {
    return null;
  }
}

export async function deleteDocument(id: string): Promise<boolean> {
  const metadata = await getDocumentById(id);
  if (!metadata) return false;

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);

  try { await fs.unlink(filePath); } catch { /* ignore */ }
  try { await fs.unlink(metadataPath); } catch { /* ignore */ }

  return true;
}

export async function cleanupDocuments(keepIds: string[]): Promise<number> {
  const allDocs = await getDocumentList();
  let deletedCount = 0;

  for (const doc of allDocs) {
    if (!keepIds.includes(doc.id)) {
      const filePath = path.join(UPLOAD_DIR, doc.storedName);
      const metadataPath = path.join(UPLOAD_DIR, `${doc.id}.json`);

      try { await fs.unlink(filePath); deletedCount++; } catch { /* ignore */ }
      try { await fs.unlink(metadataPath); } catch { /* ignore */ }
      console.log(`清理文件: ${doc.originalName} (${doc.id})`);
    }
  }

  return deletedCount;
}
