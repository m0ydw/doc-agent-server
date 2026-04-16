// 引入 config（统一读取配置）
const express = require("express");
const config = require("./config");

// 引入 app
const app = require("./app");
const docRoutes = require("./routes/docRoutes");
const { UPLOAD_DIR } = require("./services/docServices");

// 静态文件服务 - 提供上传文件的访问
app.use("/uploads", express.static(UPLOAD_DIR));

// ------------ 文档管理路由 ------------
app.use("/api/docs", docRoutes);
// -------------------------------------------

// 从 config 里拿端口 ✅
const PORT = config.PORT;

// 启动服务
app.listen(PORT, () => {
  console.log("Node 后端已启动");
  console.log(`地址：http://localhost:${PORT}`);
  console.log(`对接 Python AI：${config.PYTHON_API_URL}`);
});
