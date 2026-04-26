// 引入 config（统一读取配置）
import express from "express";
import Y from "yjs";
import { Server } from "@hocuspocus/server";
import config from "./config";

// 引入 app
import app from "./app";
import docRoutes from "./routes/docRoutes";
import docOperationsRoutes from "./routes/docOperationsRoutes";
import { UPLOAD_DIR } from "./services/docServices";
import * as sessionManager from "./services/session";

// 静态文件服务 - 提供上传文件的访问
app.use("/uploads", express.static(UPLOAD_DIR));

// ------------ 文档管理路由 ------------
app.use("/api/docs", docRoutes);
// -----------------------------------

// ------------ 文档操作路由 ------------
app.use("/api/doc-operations", docOperationsRoutes);
// -----------------------------------

// 从 config 里拿端口
const PORT = config.PORT;

// 启动 HTTP 服务
app.listen(PORT, () => {
  console.log("Node 后端已启动");
  console.log(`地址：http://localhost:${PORT}`);
});

// ------------ Hocuspocus Yjs WebSocket 服务（独立端口）------------
const hocuspocus = new Server({
  port: config.HOCUSPOCUS_PORT,

  // 文档加载回调
  onLoadDocument: async (data: { documentName: string }) => {
    const roomName = data.documentName;
    const docId = data.documentName;
    console.log("[Hocuspocus] 加载房间:", roomName);

    try {
      const existingRoom = sessionManager.getRoomByName(roomName);
      if (existingRoom) {
        console.log("[Hocuspocus] 返回已有 ydoc:", roomName);
        return existingRoom.ydoc;
      }

      const ydoc = new Y.Doc();
      console.log("[Hocuspocus] 创建新 ydoc:", roomName);

      sessionManager.registerRoom(roomName, ydoc, docId);

      return ydoc;
    } catch (error) {
      console.error("[Hocuspocus] 加载失败:", (error as Error).message);
      return new Y.Doc();
    }
  },

  // 连接回调
  onConnect: async (data: { documentName: string }) => {
    console.log("[Hocuspocus] 新连接:", data.documentName);
  },

  // 文档变化回调
  onChange: async (data: { documentName: string }) => {
    console.log("[Hocuspocus] 文档变化:", data.documentName);
  },
});

hocuspocus.listen();
console.log("Hocuspocus Yjs 服务已启动");
console.log(`协作地址：${config.HOCUSPOCUS_URL}`);
// -------------------------------------------------