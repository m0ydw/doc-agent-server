import express from "express";
import { WebSocketServer } from "ws";
import { SuperDocCollaboration } from "@superdoc-dev/superdoc-yjs-collaboration";
import config from "./config";
import app, { logger } from "./app";
import docRoutes from "./routes/docRoutes";
import docOperationsRoutes from "./routes/docOperationsRoutes";
import { UPLOAD_DIR } from "./services/docServices";
import { requiresAuth } from "./middleware/auth";

// ================================================================
// 上传目录静态服务（需简单认证）
// ================================================================

app.use("/uploads", requiresAuth, express.static(UPLOAD_DIR));

// 路由
app.use("/api/docs", docRoutes);
app.use("/api/doc-operations", docOperationsRoutes);

// ================================================================
// 启动 HTTP 服务
// ================================================================

const PORT = config.PORT;

const server = app.listen(PORT, () => {
  logger.info(`Node 后端已启动，地址：http://localhost:${PORT}`);
  logger.info(`Agent WS：ws://localhost:${PORT}/ws/agent`);
});

// ================================================================
// Agent WebSocket Server
// ================================================================

import { attachAgentWs } from "./ai/core/wsAgentHandler";
attachAgentWs(server);

// ================================================================
// uploads 文件清理策略
// ================================================================
//
//   CLEANUP_ON_START=true  → 启动时全量删除（开发调试用）
//   CLEANUP_ON_START 未设   → 定时清理超过 24 小时的过期文件（默认）
//
// ================================================================

import fs from "fs";
import path from "path";

const MAX_FILE_AGE_HOURS = Number(process.env.MAX_FILE_AGE_HOURS) || 24;
const CLEANUP_INTERVAL_MS =
  (Number(process.env.CLEANUP_INTERVAL_MINUTES) || 60) * 60 * 1000;
const FULL_CLEANUP_ON_START = process.env.CLEANUP_ON_START === "true";
//全部清理函数
function removeAllFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir);
  let count = 0;
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        count++;
      }
    } catch {
      // 忽略单文件删除失败
    }
  }
  return count;
}
//过期清理函数
function cleanupExpiredFiles(): void {
  const uploadPath = path.resolve(UPLOAD_DIR);
  if (!fs.existsSync(uploadPath)) return;

  const files = fs.readdirSync(uploadPath);
  const now = Date.now();
  let deletedCount = 0;

  for (const file of files) {
    const filePath = path.join(uploadPath, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const ageHours = (now - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours > MAX_FILE_AGE_HOURS) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
    } catch {
      // 忽略单文件删除失败
    }
  }

  if (deletedCount > 0) {
    logger.info(
      `[清理] 已删除 ${deletedCount} 个过期文件（>${MAX_FILE_AGE_HOURS}h）`
    );
  }
}

if (FULL_CLEANUP_ON_START) {
  // 开发模式：启动时全量清空
  const deleted = removeAllFiles(path.resolve(UPLOAD_DIR));
  if (deleted > 0) {
    logger.info(`[清理] CLEANUP_ON_START=true，已清空 ${deleted} 个残留文件`);
  }
} else {
  // 默认模式：首次启动运行一次过期清理 + 定时扫描
  cleanupExpiredFiles();
  setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL_MS);
}

// ================================================================
// 初始化
// ================================================================

import { initFileRegistry } from "./services/fileRegistry";
void initFileRegistry();

import { initGlobalAgent } from "./ai/agent/globalAgent";
initGlobalAgent();

// ================================================================
// SuperDoc Yjs Collaboration Server
// ================================================================

const collaborationService = new SuperDocCollaboration({
  name: "doc-agent-collab",
  debounce: 500,
});

const wss = new WebSocketServer({ port: config.COLLAB_WS_PORT });

wss.on("connection", (ws, req) => {
  const roomName = req.url?.slice(1) || "default";
  logger.info(`[Collab] 新连接: ${roomName}`);

  collaborationService.welcome(ws as any, {
    url: req.url ?? "/",
    params: { documentId: roomName },
    headers: req.headers,
  });
});

wss.on("error", (err) => {
  logger.error(`[Collab] 服务器错误: ${err.message}`);
});

logger.info(`SuperDoc 协作服务已启动（端口 ${config.COLLAB_WS_PORT}）`);
logger.info(`协作地址：${config.COLLAB_WS_URL}`);
