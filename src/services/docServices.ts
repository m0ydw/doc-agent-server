// 文档元数据 CRUD 服务 — 管理文档文件及其元数据（JSON）的持久化
// 为什么用 JSON 文件而非数据库：当前系统文档数量有限，文件系统直接读写足够简洁
// 每个文档对应两个文件：{id}.json（元数据）和 {id}.{ext}（文档本身）

import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { createHash } from "crypto";
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
  lastSavedHash?: string; // 最近一次保存的文件 hash，用于避免无差异覆盖
  lastSavedAt?: string;   // 最近一次保存时间
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const crcTable = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateTime(date = new Date()): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, date: dosDate };
}

function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = zipDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildDocxBuffer(paragraphs: string[]): Buffer {
  const now = new Date().toISOString();
  const body = paragraphs.length ? paragraphs : [""];
  const paragraphXml = body
    .map(
      (text) =>
        `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`,
    )
    .join("");

  return createZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
        "utf8",
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
        "utf8",
      ),
    },
    {
      name: "word/_rels/document.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
        "utf8",
      ),
    },
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphXml}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`,
        "utf8",
      ),
    },
    {
      name: "docProps/core.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>DocAgent</dc:creator>
  <cp:lastModifiedBy>DocAgent</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
        "utf8",
      ),
    },
    {
      name: "docProps/app.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>DocAgent</Application>
</Properties>`,
        "utf8",
      ),
    },
  ]);
}

export async function createBlankDocument(options: {
  originalName?: string;
  title?: string;
  paragraphs?: string[];
}): Promise<DocumentMetadata> {
  const originalName = (options.originalName || "新建文档.docx").trim();
  const safeName = originalName.toLowerCase().endsWith(".docx")
    ? originalName
    : `${originalName}.docx`;
  const paragraphs = [
    ...(options.title ? [options.title] : []),
    ...(options.paragraphs?.length ? options.paragraphs : [""]),
  ];
  const buffer = buildDocxBuffer(paragraphs);
  return saveDocument({
    originalname: safeName,
    buffer,
    size: buffer.byteLength,
    mimetype: DOCX_MIME,
  });
}

async function writeMetadata(metadata: DocumentMetadata): Promise<void> {
  await fs.writeFile(
    path.join(UPLOAD_DIR, `${metadata.id}.json`),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
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
  const initialHash = sha256(file.buffer);

  const metadata: DocumentMetadata = {
    id: fileId,
    roomName: fileId,         // 默认房间名 = 文件 ID
    originalName: file.originalname,
    storedName: storedFilename,
    size: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date().toISOString(),
    filePath: `/uploads/${storedFilename}`,
    lastSavedHash: initialHash,
    lastSavedAt: new Date().toISOString(),
  };

  // 元数据以 JSON 文件形式与文档文件并列存放，方便直接扫描
  await writeMetadata(metadata);

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
      const docPath = path.join(UPLOAD_DIR, doc.storedName);
      try {
        await fs.access(docPath);
      } catch {
        await fs.unlink(path.join(UPLOAD_DIR, f)).catch(() => {});
        console.warn(
          `[DocServices] 已移除缺失源文件的元数据: ${doc.originalName} (${doc.id})`,
        );
        continue;
      }
      if (!doc.lastSavedHash) {
        const buffer = await fs.readFile(docPath);
        doc.lastSavedHash = sha256(buffer);
        doc.lastSavedAt = doc.uploadedAt;
        await writeMetadata(doc);
      }
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
    if (!doc.lastSavedHash) {
      const docPath = path.join(UPLOAD_DIR, doc.storedName);
      const buffer = await fs.readFile(docPath);
      doc.lastSavedHash = sha256(buffer);
      doc.lastSavedAt = doc.uploadedAt;
      await writeMetadata(doc);
    }
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

export async function saveDocumentContent(
  id: string,
  buffer: Buffer,
): Promise<{ saved: boolean; hash: string; metadata: DocumentMetadata }> {
  const metadata = await getDocumentById(id);
  if (!metadata) {
    throw new Error(`文档不存在: ${id}`);
  }

  const hash = sha256(buffer);
  if (metadata.lastSavedHash === hash) {
    return { saved: false, hash, metadata };
  }

  await fs.writeFile(path.join(UPLOAD_DIR, metadata.storedName), buffer);
  metadata.size = buffer.byteLength;
  metadata.lastSavedHash = hash;
  metadata.lastSavedAt = new Date().toISOString();
  await writeMetadata(metadata);

  return { saved: true, hash, metadata };
}

export async function refreshSavedStateFromDisk(
  id: string,
): Promise<{ saved: boolean; hash: string; metadata: DocumentMetadata }> {
  const metadata = await getDocumentById(id);
  if (!metadata) {
    throw new Error(`文档不存在: ${id}`);
  }

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  const buffer = await fs.readFile(filePath);
  const hash = sha256(buffer);
  const saved = metadata.lastSavedHash !== hash;

  if (saved) {
    metadata.size = buffer.byteLength;
    metadata.lastSavedHash = hash;
    metadata.lastSavedAt = new Date().toISOString();
    await writeMetadata(metadata);
  }

  return { saved, hash, metadata };
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
