// 引入 config（统一读取配置）
const express = require("express");
const Y = require("yjs");
const { Server } = require("@hocuspocus/server");
const config = require("./config");

// 引入 app
const app = require("./app");
const docRoutes = require("./routes/docRoutes");
const docOperationsRoutes = require("./routes/docOperationsRoutes");
const { UPLOAD_DIR } = require("./services/docServices");
const sessionManager = require("./services/session");

// 静态文件服务 - 提供上传文件的访问
app.use("/uploads", express.static(UPLOAD_DIR));

// ------------ 文档管理路由 ------------
app.use("/api/docs", docRoutes);
// -------------------------------------------

// ------------ 文档操作路由 ------------
app.use("/api/doc-operations", docOperationsRoutes);
// -------------------------------------------

// 从 config 里拿端口 ✅
const PORT = config.PORT;

// 启动 HTTP 服务
app.listen(PORT, () => {
  console.log("Node 后端已启动");
  console.log(`地址：http://localhost:${PORT}`);
  console.log(`对接 Python AI：${config.PYTHON_API_URL}`);
});

// ------------ Hocuspocus Yjs WebSocket 服务（独立端口）------------
const hocuspocus = new Server({
  port: config.HOCUSPOCUS_PORT,

  // 文档加载回调
  onLoadDocument: async (data) => {
    const roomName = data.documentName;
    console.log("[Hocuspocus] 加载房间:", roomName);

    try {
      // 协作房间由 sessionManager 维护，避免在 onLoadDocument 中再次触发 SDK open 递归。
      const ydoc = sessionManager.getOrCreateRoomYDoc(roomName);
      console.log("[Hocuspocus] 房间 Yjs 文档已就绪:", roomName);
      return ydoc;
    } catch (error) {
      console.error("[Hocuspocus] 加载失败:", error.message);
      return new Y.Doc();
    }
  },

  // 连接回调
  onConnect: async (data) => {
    console.log("[Hocuspocus] 新连接:", data.documentName);
  },

  // 同步回调
  onSync: async (data) => {
    console.log("[Hocuspocus] 同步完成:", data.documentName);
  },

  // 文档变化回调
  onChange: async (data) => {
    console.log("[Hocuspocus] 文档变化:", data.documentName);
  },
});

hocuspocus.listen();
console.log("Hocuspocus Yjs 服务已启动");
console.log(`协作地址：${config.HOCUSPOCUS_URL}`);
// -------------------------------------------------
