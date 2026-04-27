import express from "express";
import { WebSocketServer } from "ws";
import { SuperDocCollaboration } from "@superdoc-dev/superdoc-yjs-collaboration";
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

// ===== SuperDoc Yjs Collaboration Server =====

// 启动时清理 uploads 目录（清除上次会话的残留文件）
import fs from "fs";
import path from "path";
const uploadPath = path.resolve(UPLOAD_DIR);
if (fs.existsSync(uploadPath)) {
  const files = fs.readdirSync(uploadPath);
  for (const file of files) {
    const filePath = path.join(uploadPath, file);
    if (fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    }
  }
  console.log(`[启动] uploads 目录已清理，共 ${files.length} 个残留文件`);
}

// 创建协作服务实例
const collaborationService = new SuperDocCollaboration({
  name: "doc-agent-collab",
  debounce: 500,
  // 可以添加 onAuthenticate、onLoad、onAutoSave 等钩子
});

// WebSocket 服务端
const wss = new WebSocketServer({ port: config.COLLAB_WS_PORT });

wss.on("connection", (ws, req) => {
  const roomName = req.url?.slice(1) || "default";
  console.log(`[Collab] 新连接: ${roomName}`);

  // 将 ws 和 req 转接给协作服务
  collaborationService.welcome(ws as any, {
    url: req.url ?? "/",
    params: { documentId: roomName },
    headers: req.headers,
  });
});

wss.on("error", (err) => {
  console.error(`[Collab] 服务器错误: ${err.message}`);
});

console.log(`SuperDoc 协作服务已启动（端口 ${config.COLLAB_WS_PORT}）`);
console.log(`协作地址：${config.COLLAB_WS_URL}`);
// ========================================
