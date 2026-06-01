/**
 * ============================================================
 * 【文档元数据CRUD服务 - docServices.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是文档元数据CRUD服务的核心模块，负责：
 * 1. 文档文件的保存和读取
 * 2. 文档元数据的管理（JSON文件）
 * 3. 文档列表的获取
 * 4. 文档的删除和清理
 * 5. 文档内容的保存和刷新
 * 
 * 【架构位置】
 * docRoutes.ts → 【docServices】 → 文件系统
 * 
 * 【数据流】
 * 路由调用saveDocument(file)
 *   ↓
 * 生成唯一ID和文件名
 *   ↓
 * 写入文件到uploads目录
 *   ↓
 * 生成元数据并写入JSON文件
 *   ↓
 * 返回元数据
 * 
 * 【存储设计】
 * 每个文档对应两个文件：
 * - {id}.json: 元数据文件
 * - {id}.{ext}: 文档本身
 * 
 * 【为什么用JSON文件而非数据库？】
 * 当前系统文档数量有限
 * 文件系统直接读写足够简洁
 * 
 * 【使用的库】
 * fs: Node.js文件系统模块
 *   - fs/promises: 异步文件操作
 *   - existsSync: 同步检查文件是否存在
 *   - mkdirSync: 同步创建目录
 * 
 * path: Node.js路径模块
 *   - 路径处理（拼接、解析）
 * 
 * crypto: Node.js加密模块
 *   - createHash: 创建哈希
 *   - sha256: SHA-256哈希算法
 * 
 * uuid: UUID生成库
 *   - v4: 生成UUID v4
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【文件系统模块】
// 异步文件操作
import fs from "fs/promises";
// 同步文件操作
import { existsSync, mkdirSync } from "fs";

// 【路径模块】
// 路径处理（拼接、解析）
import path from "path";

// 【加密模块】
// 创建哈希
import { createHash } from "crypto";

// 【UUID生成库】
// 生成UUID v4
import { v4 as uuidv4 } from "uuid";

// ================================================================
// 【常量定义】
// ================================================================

/**
 * 【上传目录】
 * 
 * 【功能说明】
 * 所有上传文档及其元数据的存放位置
 * 使用path.join确保跨平台兼容性
 */
export const UPLOAD_DIR = path.join(__dirname, "../../uploads");

// ================================================================
// 【辅助函数】
// ================================================================

/**
 * 【确保上传目录存在】
 * 
 * 【功能说明】
 * 确保uploads目录存在
 * 同步操作只在启动/初始化时调用，不影响事件循环
 * 使用mkdirSync的recursive选项，即使多层目录缺失也能一次性创建
 */
function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/**
 * 【生成唯一文件ID】
 * 
 * 【功能说明】
 * 使用UUID v4避免碰撞
 * UUID v4是随机生成的UUID，碰撞概率极低
 * 
 * @returns 唯一文件ID
 */
function generateFileId(): string {
  return uuidv4();
}

// ================================================================
// 【类型定义】
// ================================================================

/**
 * 【文档元数据接口】
 * 
 * 【功能说明】
 * 记录文档的所有关键信息
 * 
 * 【字段说明】
 * @property id - 唯一标识符（UUID）
 * @property roomName - Yjs协作房间名，默认与id一致
 * @property originalName - 上传时的原始文件名
 * @property storedName - 磁盘上存储的文件名（id.ext格式）
 * @property size - 文件大小（字节）
 * @property mimeType - MIME类型
 * @property uploadedAt - 上传时间（ISO 8601格式）
 * @property filePath - 文件在服务器上的相对路径（如/uploads/xxx.docx）
 * @property lastSavedHash - 最近一次保存的文件hash，用于避免无差异覆盖
 * @property lastSavedAt - 最近一次保存时间
 */
export interface DocumentMetadata {
  id: string;
  roomName: string;
  originalName: string;
  storedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  filePath: string;
  lastSavedHash?: string;
  lastSavedAt?: string;
}

/**
 * 【SHA-256哈希函数】
 * 
 * 【功能说明】
 * 计算Buffer的SHA-256哈希值
 * 用于检测文件内容是否变化
 * 
 * @param buffer - 文件内容
 * @returns SHA-256哈希值（十六进制字符串）
 */
function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 【DOCX MIME类型】
 * 
 * 【功能说明】
 * Microsoft Office Open XML文档的标准MIME类型
 */
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ================================================================
// 【ZIP文件创建】
// ================================================================

/**
 * 【CRC-32查找表】
 * 
 * 【功能说明】
 * 预计算的CRC-32查找表
 * 用于快速计算CRC-32校验和
 */
const crcTable = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

/**
 * 【CRC-32校验和计算】
 * 
 * 【功能说明】
 * 计算Buffer的CRC-32校验和
 * 用于ZIP文件的数据完整性校验
 * 
 * @param buffer - 数据
 * @returns CRC-32校验和
 */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 【ZIP日期时间格式】
 * 
 * 【功能说明】
 * 将Date对象转换为ZIP文件格式的日期时间
 * 
 * @param date - Date对象
 * @returns ZIP格式的日期时间
 */
function zipDateTime(date = new Date()): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, date: dosDate };
}

/**
 * 【创建ZIP文件】
 * 
 * 【功能说明】
 * 从文件条目数组创建ZIP文件
 * 
 * 【ZIP文件结构】
 * - Local File Header: 本地文件头
 * - File Data: 文件数据
 * - Central Directory: 中央目录
 * - End of Central Directory: 中央目录结束
 * 
 * @param entries - 文件条目数组
 * @returns ZIP文件Buffer
 */
function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = zipDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);

    // 【Local File Header】
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // 签名
    local.writeUInt16LE(20, 4);           // 版本
    local.writeUInt16LE(0x0800, 6);       // 标志
    local.writeUInt16LE(0, 8);            // 压缩方法
    local.writeUInt16LE(time, 10);        // 修改时间
    local.writeUInt16LE(date, 12);        // 修改日期
    local.writeUInt32LE(crc, 14);         // CRC-32
    local.writeUInt32LE(data.length, 18); // 压缩大小
    local.writeUInt32LE(data.length, 22); // 未压缩大小
    local.writeUInt16LE(name.length, 26); // 文件名长度
    local.writeUInt16LE(0, 28);           // 额外字段长度
    localParts.push(local, name, data);

    // 【Central Directory】
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);  // 签名
    central.writeUInt16LE(20, 4);           // 版本
    central.writeUInt16LE(20, 6);           // 最低版本
    central.writeUInt16LE(0x0800, 8);       // 标志
    central.writeUInt16LE(0, 10);           // 压缩方法
    central.writeUInt16LE(time, 12);        // 修改时间
    central.writeUInt16LE(date, 14);        // 修改日期
    central.writeUInt32LE(crc, 16);         // CRC-32
    central.writeUInt32LE(data.length, 20); // 压缩大小
    central.writeUInt32LE(data.length, 24); // 未压缩大小
    central.writeUInt16LE(name.length, 28); // 文件名长度
    central.writeUInt16LE(0, 30);           // 额外字段长度
    central.writeUInt16LE(0, 32);           // 文件注释长度
    central.writeUInt16LE(0, 34);           // 磁盘号
    central.writeUInt16LE(0, 36);           // 内部文件属性
    central.writeUInt32LE(0, 38);           // 外部文件属性
    central.writeUInt32LE(offset, 42);      // 本地头偏移
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  // 【Central Directory End】
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // 签名
  eocd.writeUInt16LE(0, 4);                   // 磁盘号
  eocd.writeUInt16LE(0, 6);                   // 中央目录磁盘号
  eocd.writeUInt16LE(entries.length, 8);       // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10);      // 总条目数
  eocd.writeUInt32LE(centralDir.length, 12);   // 中央目录大小
  eocd.writeUInt32LE(offset, 16);              // 中央目录偏移
  eocd.writeUInt16LE(0, 20);                   // 注释长度

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ================================================================
// 【DOCX文件构建】
// ================================================================

/**
 * 【XML转义】
 * 
 * 【功能说明】
 * 对字符串进行XML转义
 * 防止特殊字符破坏XML结构
 * 
 * @param value - 原始字符串
 * @returns 转义后的字符串
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 【构建DOCX文件Buffer】
 * 
 * 【功能说明】
 * 从段落文本数组构建DOCX文件
 * 
 * 【DOCX文件结构】
 * DOCX是一个ZIP文件，包含：
 * - [Content_Types].xml: 内容类型定义
 * - _rels/.rels: 关系文件
 * - word/_rels/document.xml.rels: 文档关系
 * - word/document.xml: 文档内容
 * - docProps/core.xml: 核心属性
 * - docProps/app.xml: 应用属性
 * 
 * @param paragraphs - 段落文本数组
 * @returns DOCX文件Buffer
 */
function buildDocxBuffer(paragraphs: string[]): Buffer {
  const now = new Date().toISOString();
  const body = paragraphs.length ? paragraphs : [""];
  
  // 【构建段落XML】
  const paragraphXml = body
    .map(
      (text) =>
        `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`,
    )
    .join("");

  // 【创建ZIP文件】
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


// ================================================================
// 【文档操作函数】
// ================================================================

/**
 * 【创建空白文档】
 * 
 * 【功能说明】
 * 创建一个新的空白DOCX文档
 * 
 * @param options - 创建选项
 * @returns 文档元数据
 */
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

/**
 * 【写入元数据】
 * 
 * 【功能说明】
 * 将元数据写入JSON文件
 * 
 * @param metadata - 文档元数据
 */
async function writeMetadata(metadata: DocumentMetadata): Promise<void> {
  await fs.writeFile(
   path.join(UPLOAD_DIR, `${metadata.id}.json`),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
}

/**
 * 【保存文档】
 * 
 * 【功能说明】
 * 保存上传文件到磁盘并生成元数据
 * 
 * 【执行流程】
 * 1. 确保目录存在
 * 2. 生成唯一ID
 * 3. 写入文件
 * 4. 持久化元数据JSON
 * 
 * @param file - multer解析后的文件信息
 * @returns 生成的DocumentMetadata
 */
export async function saveDocument(file: {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}): Promise<DocumentMetadata> {
  // 【确保目录存在】
  ensureUploadDir();

  // 【生成唯一ID】
  const fileId = generateFileId();
  const ext = path.extname(file.originalname);
  
  // 【存储文件名】
  // 使用UUID + 原始扩展名，确保文件系统唯一性
  const storedFilename = `${fileId}${ext}`;
  const filePath = path.join(UPLOAD_DIR, storedFilename);

  // 【写入文件】
  await fs.writeFile(filePath, file.buffer);
  const initialHash = sha256(file.buffer);

  // 【创建元数据】
  const metadata: DocumentMetadata = {
    id: fileId,
    roomName: fileId,         // 默认房间名 = 文件ID
    originalName: file.originalname,
    storedName: storedFilename,
    size: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date().toISOString(),
    filePath: `/uploads/${storedFilename}`,
    lastSavedHash: initialHash,
    lastSavedAt: new Date().toISOString(),
  };

  // 【持久化元数据】
  await writeMetadata(metadata);

  return metadata;
}

/**
 * 【获取文档列表】
 * 
 * 【功能说明】
 * 获取所有已上传文档的列表
 * 通过扫描uploads目录中的.json元数据文件来获取
 * 
 * 【执行流程】
 * 1. 确保目录存在
 * 2. 读取目录中的所有文件
 * 3. 过滤出.json元数据文件
 * 4. 读取并解析每个元数据文件
 * 5. 按上传时间倒序排列
 * 
 * @returns 文档元数据数组
 */
export async function getDocumentList(): Promise<DocumentMetadata[]> {
  // 【确保目录存在】
  ensureUploadDir();

  // 【读取目录中的所有文件】
  const files = await fs.readdir(UPLOAD_DIR);
  
  // 【过滤出.json元数据文件】
  const metadataFiles = files.filter((f) => f.endsWith(".json"));

  const documents: DocumentMetadata[] = [];
  for (const f of metadataFiles) {
    try {
      // 【读取并解析元数据文件】
      const content = await fs.readFile(path.join(UPLOAD_DIR, f), "utf-8");
      const doc = JSON.parse(content) as DocumentMetadata;
      
      // 【兼容旧数据】
      if (!doc.roomName) doc.roomName = doc.id;
      
      // 【检查文档文件是否存在】
      const docPath = path.join(UPLOAD_DIR, doc.storedName);
      try {
        await fs.access(docPath);
      } catch {
        // 【文档文件不存在，删除元数据】
        await fs.unlink(path.join(UPLOAD_DIR, f)).catch(() => {});
         console.warn(
          `[DocServices] 已移除缺失源文件的元数据: ${doc.originalName} (${doc.id})`,
        );
        continue;
      }
      
      // 【计算哈希】
      if (!doc.lastSavedHash) {
        const buffer = await fs.readFile(docPath);
        doc.lastSavedHash = sha256(buffer);
        doc.lastSavedAt = doc.uploadedAt;
        await writeMetadata(doc);
      }
      
      documents.push(doc);
    } catch {
      // 【损坏的元数据文件不影响列表完整性】
    }
  }

  // 【按上传时间倒序排列】
  return documents.sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
}

/**
 * 【根据ID获取文档】
 * 
 * 【功能说明】
 * 根据ID查询单个文档的元数据
 * 
 * @param id - 文档ID
 * @returns 文档元数据或null
 */
export async function getDocumentById(id: string): Promise<DocumentMetadata | null> {
   const metadataPath = path.join(UPLOAD_DIR, `${id}.json`);

  try {
    // 【检查元数据文件是否存在】
    await fs.access(metadataPath);
    
    // 【读取并解析元数据文件】
    const content = await fs.readFile(metadataPath, "utf-8");
    const doc = JSON.parse(content) as DocumentMetadata;
    
    // 【兼容旧数据】
    if (!doc.roomName) doc.roomName = doc.id;
    
    // 【计算哈希】
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

/**
 * 【获取文档文件】
 * 
 * 【功能说明】
 * 获取文档文件路径及其元数据
 * 同时验证元数据和文档文件的存在性
 * 
 * @param id - 文档ID
 * @returns 文件路径和元数据，或null
 */
export async function getDocumentFile(
  id: string
): Promise<{ filePath: string; metadata: DocumentMetadata } | null> {
  // 【获取元数据】
  const metadata = await getDocumentById(id);
  if (!metadata) return null;

  // 【检查文档文件是否存在】
  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  try {
    await fs.access(filePath);
    return { filePath, metadata };
  } catch {
    return null;
  }
}

/**
 * 【保存文档内容】
 * 
 * 【功能说明】
 * 保存文档内容到磁盘
 * 如果内容没有变化（哈希相同），则不保存
 * 
 * @param id - 文档ID
 * @param buffer - 文档内容
 * @returns 保存结果
 */
export async function saveDocumentContent(
  id: string,
  buffer: Buffer,
): Promise<{ saved: boolean; hash: string; metadata: DocumentMetadata }> {
  // 【获取元数据】
  const metadata = await getDocumentById(id);
  if (!metadata) {
    throw new Error(`文档不存在: ${id}`);
  }

  // 【计算哈希】
  const hash = sha256(buffer);
  
  // 【检查内容是否变化】
  if (metadata.lastSavedHash === hash) {
    return { saved: false, hash, metadata };
  }

  // 【保存文件】
  await fs.writeFile(path.join(UPLOAD_DIR, metadata.storedName), buffer);
  
  // 【更新元数据】
  metadata.size = buffer.byteLength;
  metadata.lastSavedHash = hash;
  metadata.lastSavedAt = new Date().toISOString();
  await writeMetadata(metadata);

  return { saved: true, hash, metadata };
}

/**
 * 【从磁盘刷新保存状态】
 * 
 * 【功能说明】
 * 从磁盘读取文档文件，计算哈希，检查是否有变化
 * 如果有变化，更新元数据
 * 
 * @param id - 文档ID
 * @returns 保存结果
 */
export async function refreshSavedStateFromDisk(
  id: string,
): Promise<{ saved: boolean; hash: string; metadata: DocumentMetadata }> {
  // 【获取元数据】
  const metadata = await getDocumentById(id);
  if (!metadata) {
 throw new Error(`文档不存在: ${id}`);
  }

  // 【读取文件并计算哈希】
  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  const buffer = await fs.readFile(filePath);
  const hash = sha256(buffer);
  
  // 【检查是否有变化】
  const saved = metadata.lastSavedHash !== hash;

  // 【如果有变化，更新元数据】
  if (saved) {
    metadata.size = buffer.byteLength;
    metadata.lastSavedHash = hash;
    metadata.lastSavedAt = new Date().toISOString();
    await writeMetadata(metadata);
  }

  return { saved, hash, metadata };
}

/**
 * 【删除文档】
 * 
 * 【功能说明】
 * 删除文档及其元数据
 * 同时删除文档文件和JSON元数据文件
 * 
 * @param id - 文档ID
 * @returns 是否删除成功
 */
export async function deleteDocument(id: string): Promise<boolean> {
  // 【获取元数据】
  const metadata = await getDocumentById(id);
  if (!metadata) return false;

  const filePath = path.join(UPLOAD_DIR, metadata.storedName);
  const metadataPath = path.join(UPLOAD_DIR, ${id}.json);

  // 【删除文件】
  try { await fs.unlink(filePath); } catch { /* 文件可能已被手动删除 */ }
  try { await fs.unlink(metadataPath); } catch { /* ignore */ }

  return true;
}

/**
 * 【批量清理文档】
 * 
 * 【功能说明】
 * 批量清理文档（保留白名单中的文档）
 * 
 * @param keepIds - 应保留的文档ID列表
 * @returns 实际删除的文档文件数量
 */
export async function cleanupDocuments(keepIds: string[]): Promise<number> {
  // 【获取所有文档】
  const allDocs = await getDocumentList();
  let deletedCount = 0;

  // 【遍历删除不在白名单中的文档】
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
