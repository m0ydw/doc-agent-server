/**
 * 文件映射表（FileRegistry）
 * 维护所有已上传文档的注册信息，供全局 Agent 查询和定位文档
 * 注册时机：服务启动扫描、文档上传
 * 注销时机：文档删除
 */

import { getDocumentList, getDocumentById, DocumentMetadata } from "./docServices";

export interface DocRegistryEntry {
  docId: string;
  docPath: string;
  originalName: string;
  roomName: string;
  uploadedAt: string;
}

class FileRegistry {
  private docs: Map<string, DocRegistryEntry> = new Map();

  /**
   * 注册单个文档
   */
  register(entry: DocRegistryEntry): void {
    this.docs.set(entry.docId, entry);
    console.log(`[FileRegistry] 注册文档: ${entry.originalName} (${entry.docId})`);
  }

  /**
   * 批量注册
   */
  registerBatch(entries: DocRegistryEntry[]): void {
    for (var entry of entries) {
      this.docs.set(entry.docId, entry);
    }
    console.log(`[FileRegistry] 批量注册 ${entries.length} 个文档`);
  }

  /**
   * 注销单个文档
   */
  unregister(docId: string): void {
    var entry = this.docs.get(docId);
    if (entry) {
      console.log(`[FileRegistry] 注销文档: ${entry.originalName} (${docId})`);
      this.docs.delete(docId);
    }
  }

  /**
   * 根据 docId 查询
   */
  get(docId: string): DocRegistryEntry | undefined {
    return this.docs.get(docId);
  }

  /**
   * 根据文件名模糊匹配（用于 LLM 按文件名查找）
   */
  getByName(name: string): DocRegistryEntry | undefined {
    var lowerName = name.toLowerCase();
    for (var entry of this.docs.values()) {
      if (entry.originalName.toLowerCase() === lowerName) return entry;
    }
    // 模糊匹配：文件名包含搜索词
    for (var entry of this.docs.values()) {
      if (entry.originalName.toLowerCase().includes(lowerName)) return entry;
    }
    return undefined;
  }

  /**
   * 获取所有已注册文档
   */
  getAll(): DocRegistryEntry[] {
    return Array.from(this.docs.values());
  }

  /**
   * 获取注册数量
   */
  get count(): number {
    return this.docs.size;
  }

  /**
   * 生成给 LLM 的文档列表描述文本
   */
  toContextString(contextDocId?: string): string {
    var entries = this.getAll();
    if (entries.length === 0) return "当前没有可操作的文档。";

    var lines = ["当前可操作的文档："];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var marker = entry.docId === contextDocId ? " ← 当前查看" : "";
      lines.push(`  ${i + 1}. ${entry.originalName} (ID: ${entry.docId})${marker}`);
    }
    if (contextDocId) {
      var current = this.get(contextDocId);
      if (current) {
        lines.push(`\n用户当前正在查看: ${current.originalName}`);
        lines.push(`如需操作该文档，targetDocId 设为: ${contextDocId}`);
      }
    }
    lines.push("\n用户可通过文件名或 ID 指定要操作的文档。");
    return lines.join("\n");
  }
}

// 全局单例
export const fileRegistry = new FileRegistry();

/**
 * 从 docServices 元数据转换为注册条目
 */
function metadataToEntry(meta: DocumentMetadata): DocRegistryEntry {
  return {
    docId: meta.id,
    docPath: meta.filePath,
    originalName: meta.originalName,
    roomName: meta.roomName || meta.id,
    uploadedAt: meta.uploadedAt,
  };
}

/**
 * 初始化：扫描 uploads 目录，注册所有已有文档
 * 在服务启动时调用
 */
export function initFileRegistry(): void {
  console.log("[FileRegistry] 启动初始化：扫描已有文档...");
  var documents = getDocumentList();
  var entries = documents.map(metadataToEntry);
  fileRegistry.registerBatch(entries);
  console.log(`[FileRegistry] 初始化完成，共 ${entries.length} 个文档`);
}

/**
 * 注册单个文档（供 docRoutes 上传时调用）
 */
export function registerDocument(meta: DocumentMetadata): void {
  fileRegistry.register(metadataToEntry(meta));
}

/**
 * 注销单个文档（供 docRoutes 删除时调用）
 */
export function unregisterDocument(docId: string): void {
  fileRegistry.unregister(docId);
}
