import express from "express";
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
const hocuspocus = new Server({
  port: config.HOCUSPOCUS_PORT,

  // 连接回调
  onConnect: async (data: { documentName: string }) => {
    console.log("[Hocuspocus] 新连接:", data.documentName);
  },

  // 文档变化回调
  onChange: async (data: { documentName: string; document: any }) => {
    console.log("[Hocuspocus] 文档变化:", data.documentName);
  },
});

hocuspocus.listen();
console.log("Hocuspocus Yjs 服务已启动");
console.log(`协作地址：${config.HOCUSPOCUS_URL}`);
// ========================================