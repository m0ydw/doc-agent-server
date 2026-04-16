const express = require("express");
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-File-Name, X-Original-Filename");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ verify: (req, res, buf) => {
  req.rawBody = buf;
}}));

app.use(express.urlencoded({ extended: true, verify: (req, res, buf) => {
  req.rawBody = buf;
}}));

const aiRoutes = require("./routes/aiRoutes");
app.use("/api/ai", aiRoutes);

module.exports = app;
