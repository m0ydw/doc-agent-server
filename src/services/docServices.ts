import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export const UPLOAD_DIR = path.join(__dirname, "../../uploads");

// 确保上传目录存在
function ensureUploadDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

// 生成文件 ID
function generateFileId(): string {
  return uuidv4();
}

// ===== 文档元数据 =====

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

// ===== 基础文件服务 =====

/**
 * 保存文档（写入临时种子文件，播种后会被删除）
 * 返回元数据供后续使用
 */
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

  // 保存元数据 JSON
  const metadataPath = path.join(UPLOAD_DIR, `${fileId}.json`);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return metadata;
}

/**
 * 获取文档元数据列表
 */
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

/**
 * 根据 ID 获取文档元数据
 */
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

/**
 * 获取文档文件路径和元数据
 */
export function getDocumentFile(
  id: string
): { path: string; metadata: DocumentMetadata } | null {
  const metadata = getDocumentById(id);

  if (!metadata) {
    return null;
  }

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);

  if (!fs.existsSync(filePath)) {
    // 文件可能被删除了（如种子文件），返回元数据但不包含文件
    return null;
  }

  return {
    path: filePath,
    metadata,
  };
}

/**
 * 删除文档
 */
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

/**
 * 清理文档（批量删除）
 */
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