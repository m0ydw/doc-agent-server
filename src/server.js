// 引入 config（统一读取配置）
const express = require("express");
const config = require("./config");
const { Server } = require("@hocuspocus/server");

// 引入 app
const app = require("./app");
const docRoutes = require("./routes/docRoutes");
const docOperationsRoutes = require("./routes/docOperationsRoutes");
const { UPLOAD_DIR } = require("./services/docServices");

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
const server = app.listen(PORT, () => {
  console.log("Node 后端已启动");
  console.log(`地址：http://localhost:${PORT}`);
  console.log(`对接 Python AI：${config.PYTHON_API_URL}`);
});

// ------------ Hocuspocus Yjs WebSocket 服务 ------------
const hocuspocusServer = Server.listen({
  port: 1234,
  name: "superdoc-collaboration",
  extensions: [],
  async onLoadDocument(data) {
    // 从文件加载文档初始化 Yjs（可选）
    return data.document;
  },
});

// 启动 Hocuspocus 服务
server.on("upgrade", (request, socket, head) => {
  // 只有 /hocuspocus 路径的请求才转发到 Hocuspocus
  if (request.url.startsWith("/hocuspocus")) {
    hocuspocusServer.handleUpgrade(request, socket, head);
  }
});

console.log("Hocuspocus Yjs 服务已启动");
console.log("协作地址：ws://localhost:1234/hocuspocus");
// -------------------------------------------------
