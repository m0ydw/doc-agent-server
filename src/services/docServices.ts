// 文档元数据 CRUD 服务 — 管理文档文件及其元数据（JSON）的持久化
// 为什么用 JSON 文件而非数据库：当前系统文档数量有限，文件系统直接读写足够简洁
// 每个文档对应两个文件：{id}.json（元数据）和 {id}.{ext}（文档本身）

import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// uploads 目录 — 所有上传文档及其元数据的存放位置
export const UPLOAD_DIR = path.join(__dirname, "../../uploads");

// 确保 uploads 目录存在 — 同步操作只在启动/初始化时调用，不影响事件循环
// 使用 mkdirSync 的 recursive 选项，即使多层目录缺失也能一次性创建
function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

// 生成唯一文件 ID — 使用 UUID v4 避免碰撞
function generateFileId(): string {
  return uuidv4();
}

// 文档元数据接口 — 记录文档的所有关键信息
export interface DocumentMetadata {
  id: string;           // 唯一标识符（UUID）
  roomName: string;     // Yjs 协作房间名，默认与 id 一致
  originalName: string; // 上传时的原始文件名
  storedName: string;   // 磁盘上存储的文件名（id.ext 格式）
  size: number;         // 文件大小（字节）
  mimeType: string;     // MIME 类型
  uploadedAt: string;   // 上传时间（ISO 8601 格式）
  filePath: string;     // 文件在服务器上的相对路径（如 /uploads/xxx.docx）
}

// saveDocument — 保存上传文件到磁盘并生成元数据
// 输入：multer 解析后的文件信息（原始名、Buffer、大小、MIME）
// 输出：生成的 DocumentMetadata
// 流程：确保目录存在 → 生成唯一 ID → 写入文件 → 持久化元数据 JSON
export async function saveDocument(file: {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}): Promise<DocumentMetadata> {
  ensureUploadDir();

  const fileId = generateFileId();
  const ext = path.extname(file.originalname);
  // 存储文件名使用 UUID + 原始扩展名，确保文件系统唯一性
  const storedFilename = `${fileId}${ext}`;
  const filePath = path.join(UPLOAD_DIR, storedFilename);

  await fs.writeFile(filePath, file.buffer);

  const metadata: DocumentMetadata = {
    id: fileId,
    roomName: fileId,         // 默认房间名 = 文件 ID
    originalName: file.originalname,
    storedName: storedFilename,
    size: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date().toISOString(),
    filePath: `/uploads/${storedFilename}`,
  };

  // 元数据以 JSON 文件形式与文档文件并列存放，方便直接扫描
  const metadataPath = path.join(UPLOAD_DIR, `${fileId}.json`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return metadata;
}

// getDocumentList — 获取所有已上传文档的列表
// 通过扫描 uploads 目录中的 .json 元数据文件来获取
// 返回按上传时间倒序排列的 DocumentMetadata 数组
// 损坏的元数据文件会被静默跳过
export async function getDocumentList(): Promise<DocumentMetadata[]> {
  ensureUploadDir();

  const files = await fs.readdir(UPLOAD_DIR);
  // 只读取 .json 元数据文件，忽略文档文件本身
  const metadataFiles = files.filter((f) => f.endsWith(".json"));

  const documents: DocumentMetadata[] = [];
  for (const f of metadataFiles) {
    try {
      const content = await fs.readFile(path.join(UPLOAD_DIR, f), "utf-8");
      const doc = JSON.parse(content) as DocumentMetadata;
      // 兼容旧数据：如果 roomName 字段缺失，默认设为 id
      if (!doc.roomName) doc.roomName = doc.id;
      documents.push(doc);
    } catch {
      // 损坏的元数据文件不影响列表完整性
    }
  }

  // 按上传时间倒序排列，最新的文件排在前面
  return documents.sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
}

// getDocumentById — 根据 ID 查询单个文档的元数据
// 输入：文档 ID
// 输出：DocumentMetadata 或 null（文档不存在/元数据损坏时）
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

// getDocumentFile — 获取文档文件路径及其元数据
// 同时验证元数据和文档文件的存在性，返回两者的组合
// 只有元数据和文档文件都存在时才返回有效结果
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

// deleteDocument — 删除文档及其元数据
// 同时删除文档文件和 JSON 元数据文件
// 两阶段的 try/catch 保证一个文件删除失败不影响另一个
// 返回 true 表示元数据存在且删除操作已执行
export async function deleteDocument(id: string): Promise<boolean> {
  const metadata = await getDocumentById(id);
  if (!metadata) return false;

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);

  try { await fs.unlink(filePath); } catch { /* 文件可能已被手动删除 */ }
  try { await fs.unlink(metadataPath); } catch { /* ignore */ }

  return true;
}

// cleanupDocuments — 批量清理文档（保留白名单中的文档）
// keepIds 是应保留的文档 ID 列表，不在列表中的文档都会被删除
// 返回实际删除的文档文件数量
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
