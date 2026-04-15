const express = require("express");
const app = express();

// 中间件
app.use(express.json());

// ------------ ai路由（前端调用转发python） ------------
const aiRoutes = require("./routes/aiRoutes");
app.use("/api/ai", aiRoutes);
// -------------------------------------------

module.exports = app;
