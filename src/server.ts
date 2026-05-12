// 主入口文件：组装所有子系统并启动服务
// 启动顺序：Express HTTP → Agent WebSocket → 文件清理策略 → 初始化 → 协作服务
// 注意：协作服务使用独立端口（COLLAB_WS_PORT），不与 HTTP 端口冲突

import express from "express";
import { WebSocketServer } from "ws";
import { SuperDocCollaboration } from "@superdoc-dev/superdoc-yjs-collaboration";
import config from "./config";
import app, { logger } from "./app";
import docRoutes from "./routes/docRoutes";
import docOperationsRoutes from "./routes/docOperationsRoutes";
import { UPLOAD_DIR } from "./services/docServices";
import { requiresAuth } from "./middleware/auth";

// 将 uploads 目录通过 HTTP 静态服务暴露给前端
// 使用轻量认证中间件防止外部直接访问敏感文件
app.use("/uploads", requiresAuth, express.static(UPLOAD_DIR));

// 路由挂载：文档管理（上传/列表/删除/清理）+ 文档操作（查找/替换/文本提取）
app.use("/api/docs", docRoutes);
app.use("/api/doc-operations", docOperationsRoutes);

// AI Agent REST API 路由 — 供前端调用以获取 Agent 状态或触发重置/配置
import { getAgentStatus, resetAgent, setAgentConfig } from "./ai/service/aiService";

const aiRouter = express.Router();
// 查询当前 Agent 工作状态
aiRouter.get("/agent/status", getAgentStatus);
// 重置 Agent 内部状态（清空历史、重新初始化）
aiRouter.post("/agent/reset", resetAgent);
// 动态设置 Agent 配置（如 LLM 模型参数）
aiRouter.post("/agent/config", setAgentConfig);
app.use("/api/ai", aiRouter);

// 启动 HTTP 服务 — 同时承载 REST API 和 Agent WebSocket
const PORT = config.PORT;
const server = app.listen(PORT, () => {
  logger.info(`Node 后端已启动，地址：http://localhost:${PORT}`);
  logger.info(`Agent WS：ws://localhost:${PORT}/ws/agent`);
});

// Agent WebSocket 挂载到同一个 HTTP 服务器上
// 前端 Agent 对话通过此 WebSocket 通道与后端通信
import { attachAgentWs } from "./ai/core/wsAgentHandler";
attachAgentWs(server);

// uploads 文件清理策略
// 两种模式：
//   CLEANUP_ON_START=true  → 启动时全量删除（开发环境用，每次重启清空测试数据）
//   CLEANUP_ON_START 未设   → 定时清理超过 MAX_FILE_AGE_HOURS 的过期文件（生产默认）
// 目的：防止磁盘被历史上传文件占满，也避免残留文件干扰新的操作

import fs from "fs";
import path from "path";

// 文件最大保留时长（小时），超期自动删除
const MAX_FILE_AGE_HOURS = Number(process.env.MAX_FILE_AGE_HOURS) || 24;
// 定时清理间隔（毫秒），默认每 60 分钟扫描一次
const CLEANUP_INTERVAL_MS =
  (Number(process.env.CLEANUP_INTERVAL_MINUTES) || 60) * 60 * 1000;
const FULL_CLEANUP_ON_START = process.env.CLEANUP_ON_START === "true";

// 全量删除目录下所有文件（用于开发环境启动时清空）
// 输入：目标目录路径；输出：实际删除的文件数
// 不删除子目录，只删除文件
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
      // 单文件删除失败不中断整个清理流程，确保尽可能多的文件被处理
    }
  }
  return count;
}

// 定时清理过期文件 — 遍历 uploads 目录删除超过 MAX_FILE_AGE_HOURS 的文件
// 设计为无返回值、无异常的容错函数，即使某文件删除失败也不影响后续文件
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
        // 计算文件年龄（小时），超过阈值则删除
        const ageHours = (now - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours > MAX_FILE_AGE_HOURS) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
    } catch {
      // 忽略单文件删除失败，确保整个遍历不被中断
    }
  }

  if (deletedCount > 0) {
    logger.info(
      `[清理] 已删除 ${deletedCount} 个过期文件（>${MAX_FILE_AGE_HOURS}h）`
    );
  }
}

if (FULL_CLEANUP_ON_START) {
  // 开发模式：启动时全量清空 uploads 目录，避免上次运行的残留文件干扰本轮调试
  const deleted = removeAllFiles(path.resolve(UPLOAD_DIR));
  if (deleted > 0) {
    logger.info(`[清理] CLEANUP_ON_START=true，已清空 ${deleted} 个残留文件`);
  }
} else {
  // 生产/默认模式：首次启动立即运行一次过期清理，之后按 CLEANUP_INTERVAL_MS 定时扫描
  // 这样即使服务长时间运行也能持续回收磁盘空间
  cleanupExpiredFiles();
  setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL_MS);
}

// 初始化流程
// 文件注册表初始化必须在路由注册之后、Agent 初始化之前
// 确保 Agent 启动时就能通过注册表查询到已有文档
import { initFileRegistry } from "./services/fileRegistry";
void initFileRegistry();

// 全局 AI Agent 初始化 — 加载配置、连接 LLM、准备工具链
import { initGlobalAgent } from "./ai/agent/globalAgent";
initGlobalAgent();

// SuperDoc Yjs 协作服务 — 使用独立端口，通过 y-websocket 协议
// 选择独立端口的原因：避免与 HTTP/Agent WebSocket 冲突，且便于单独扩展
// 前端编辑器通过此服务与 SDK Agent 共享同一份 Yjs 文档数据
const collaborationService = new SuperDocCollaboration({
  name: "doc-agent-collab",
  debounce: 500,  // 500ms 防抖：合并短时间内多次编辑，减少同步请求频率
});

const wss = new WebSocketServer({ port: config.COLLAB_WS_PORT });

// 新连接到达时，从 URL path 中提取房间名
// 每个房间对应一个文档，同一房间内的连接共享协作状态
wss.on("connection", (ws, req) => {
  // URL 格式: ws://host:port/roomName，slice(1) 去掉开头的 "/"
  const roomName = req.url?.slice(1) || "default";
  logger.info(`[Collab] 新连接: ${roomName}`);

  // 将连接交给 SuperDocCollaboration 管理，自动处理 Yjs 同步与冲突解决
  collaborationService.welcome(ws as any, {
    url: req.url ?? "/",
    params: { documentId: roomName },
    headers: req.headers,
  });
});

// 协作服务级别的错误处理 — 不会因单连接异常导致整个服务崩溃
wss.on("error", (err) => {
  logger.error(`[Collab] 服务器错误: ${err.message}`);
});

logger.info(`SuperDoc 协作服务已启动（端口 ${config.COLLAB_WS_PORT}）`);
logger.info(`协作地址：${config.COLLAB_WS_URL}`);
