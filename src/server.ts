import express from "express";
import Y from "yjs";
import { Server } from "@hocuspocus/server";
import config from "./config";

import app from "./app";
import docRoutes from "./routes/docRoutes";
import docOperationsRoutes from "./routes/docOperationsRoutes";
import { UPLOAD_DIR } from "./services/docServices";

// 静态文件服务
app.use("/uploads", express.static(UPLOAD_DIR));

// 路由
app.use("/api/docs", docRoutes);
app.use("/api/doc-operations", docOperationsRoutes);

// 端口
const PORT = config.PORT;

// 启动 HTTP 服务
app.listen(PORT, () => {
  console.log("Node 后端已启动");
  console.log(`地址：http://localhost:${PORT}`);
});

// ===== Hocuspocus Server (纯内存 Yjs) =====

// 文档实例缓存 Map — 确保同一房间的文档实例被复用
const docsCache = new Map<string, Y.Doc>();

const hocuspocus = new Server({
  port: config.HOCUSPOCUS_PORT,

  // 文档加载回调 - 复用已有文档实例，确保 sync 正常握手
  onLoadDocument: async (data) => {
    const { documentName } = data;
    if (!docsCache.has(documentName)) {
      docsCache.set(documentName, new Y.Doc());
      console.log(`[Hocuspocus] 创建新文档: ${documentName}`);
    }
    const doc = docsCache.get(documentName)!;
    console.log(`[Hocuspocus] 返回已有文档: ${documentName}`);
    return doc;
  },

  // 连接回调
  onConnect: async (data) => {
    console.log("[Hocuspocus] 新连接:", data.documentName);
  },

  // 文档变化回调
  onChange: async (data) => {
    console.log(`[Hocuspocus] 文档 ${data.documentName} 发生变更，当前客户端数: ${data.clientsCount ?? 'unknown'}`);
  },

  // 断开连接回调 - 可选项：清理空房间
  onDisconnect: async (data) => {
    // 连接数归零时清理缓存（可根据实际场景决定是否启用）
    if (data.clientsCount === 0) {
      // 保留最近使用的文档以便回访
      // docsCache.delete(data.documentName);
    }
  },
});

hocuspocus.listen();
console.log("Hocuspocus Yjs 服务已启动");
console.log(`协作地址：${config.HOCUSPOCUS_URL}`);
// ========================================