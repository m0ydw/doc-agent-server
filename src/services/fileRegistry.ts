// 文件映射表（FileRegistry）— 全局文档注册表
// 核心作用：维护所有已上传文档的 ID/路径/名称映射，供 AI Agent 查询和定位文档
// 设计为内存中的单例 Map，配合磁盘元数据完成双向索引
// 注册时机：服务启动扫描（initFileRegistry）、文档上传（registerDocument）
// 注销时机：文档删除（unregisterDocument）

import { getDocumentList, DocumentMetadata } from "./docServices";

interface DocRegistryEntry {
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
    for (const entry of entries) {
      this.docs.set(entry.docId, entry);
    }
    console.log(`[FileRegistry] 批量注册 ${entries.length} 个文档`);
  }

  /**
   * 注销单个文档
   */
  unregister(docId: string): void {
    const entry = this.docs.get(docId);
    if (entry) {
      this.docs.delete(docId);
    }
  }
}

// 全局单例 — 保证整个服务中只有一个注册表实例
export const fileRegistry = new FileRegistry();

// metadataToEntry — 将 docServices 元数据转换为注册表条目
// 字段映射：docId、docPath、originalName、roomName、uploadedAt
// 用于在 initFileRegistry / registerDocument 中统一转换
function metadataToEntry(meta: DocumentMetadata): DocRegistryEntry {
  return {
    docId: meta.id,
    docPath: meta.filePath,
    originalName: meta.originalName,
    roomName: meta.roomName || meta.id,
    uploadedAt: meta.uploadedAt,
  };
}

// initFileRegistry — 启动时扫描 uploads 目录，注册所有已有文档
// 调用时机：server.ts 启动初始化阶段
// 确保服务重启后 Agent 能立即感知到磁盘上已有的文档
export async function initFileRegistry(): Promise<void> {
  console.log("[FileRegistry] 启动初始化：扫描已有文档...");
  const documents = await getDocumentList();
  const entries = documents.map(metadataToEntry);
  fileRegistry.registerBatch(entries);
  console.log(`[FileRegistry] 初始化完成，共 ${entries.length} 个文档`);
}

// registerDocument — 注册单个文档到全局映射表
// 调用时机：docRoutes 上传完成后
// 让 Agent 即时感知新上传的文档，无需等待定时扫描
export function registerDocument(meta: DocumentMetadata): void {
  fileRegistry.register(metadataToEntry(meta));
}

// unregisterDocument — 从全局映射表注销单个文档
// 调用时机：docRoutes 删除文档时
// 确保 Agent 不会引用已被删除的文档 ID
export function unregisterDocument(docId: string): void {
  fileRegistry.unregister(docId);
}
