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
    const docId = data.documentName; // 使用 roomName 作为 docId
    console.log("[Hocuspocus] 加载房间:", roomName);

    try {
      // 检查 room 是否已存在
      const existingRoom = sessionManager.getRoomByName(roomName);
      if (existingRoom) {
        console.log("[Hocuspocus] 返回已有 ydoc:", roomName);
        return existingRoom.ydoc;
      }
      
      // 创建新的空 ydoc
      // SDK 连接时会带 doc 参数，会自动 seed 内容到 ydoc
      const ydoc = new Y.Doc();
      console.log("[Hocuspocus] 创建新 ydoc:", roomName);
      
      // 注册 room（让 SDK 加入时共享同一个 ydoc）
      sessionManager.registerRoom(roomName, ydoc, docId);
      
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
