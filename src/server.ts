// 主入口文件：组装所有子系统并启动服务
// 启动顺序：Express HTTP → 文件清理策略 → 初始化 → 协作服务
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
/**
 * 【新增】导入 Agent WebSocket 模块
 * 
 * Agent WebSocket 是 AI Agent 与前端通信的核心通道：
 * - 前端通过 WebSocket 发送任务指令（如 agent.start）
 * - 后端通过 WebSocket 实时推送 Agent 执行进度（如 tool.finished、agent.trace）
 * - 支持人机协作：当 Agent 需要审批时，前端可以发送 agent.approval.resolve
 * 
 * 【为什么用 WebSocket 而不是 HTTP】
 * - Agent 执行是长时间运行的任务（可能几分钟），HTTP 请求会超时
 * - 需要实时推送进度，WebSocket 比轮询更高效
 * - 支持双向通信，前端可以随时取消或审批
 */
import { attachAgentWebSocket } from "./services/agent/agentWs";

// 将 uploads 目录通过 HTTP 静态服务暴露给前端
// 使用轻量认证中间件防止外部直接访问敏感文件
app.use("/uploads", requiresAuth, express.static(UPLOAD_DIR));

// 路由挂载：文档管理（上传/列表/删除/清理）+ 文档操作（查找/替换/文本提取）
app.use("/api/docs", docRoutes);
app.use("/api/doc-operations", docOperationsRoutes);

// 启动 HTTP 服务
const PORT = config.PORT;
const server = app.listen(PORT, () => {
  logger.info(`Node 后端已启动，地址：http://localhost:${PORT}`);
});

/**
 * 【新增】启动 Agent WebSocket 服务
 * 
 * 将 WebSocket 服务器挂载到 HTTP 服务器上，路径为 /ws/agent
 * 这样前端可以通过 ws://localhost:3000/ws/agent 连接到 Agent
 * 
 * 【WebSocket 与 HTTP 共享端口的优势】
 * - 不需要额外的端口，简化部署
 * - 可以复用 HTTP 的认证中间件
 * - 前端只需要知道一个地址
 * 
 * 【通信协议】
 * 所有消息都是 JSON 格式，包含 type 字段标识消息类型：
 * 
 * 前端 → 后端：
 * - agent.start: 启动 Agent 任务
 * - agent.cancel: 取消正在运行的任务
 * - agent.approval.resolve: 处理审批请求
 * - agent.replay: 重新播放事件（用于页面刷新后恢复状态）
 * 
 * 后端 → 前端：
 * - agent.started: Agent 已启动
 * - agent.trace: 思考过程
 * - tool.started/tool.finished: 工具调用
 * - agent.message.delta: 流式文本片段
 * - approval.requested: 需要审批
 * - approval.resolved: 审批已处理
 * - agent.finished/agent.error: 任务结束
 */
attachAgentWebSocket(server);
logger.info(`Agent WebSocket 已启动：ws://localhost:${PORT}/ws/agent`);

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
// 文件注册表初始化必须在路由注册之后
// 确保服务启动时就能通过注册表查询到已有文档
import { initFileRegistry } from "./services/fileRegistry";
void initFileRegistry();

// SuperDoc Yjs 协作服务 — 使用独立端口，通过 y-websocket 协议
// 选择独立端口的原因：避免与 HTTP 冲突，且便于单独扩展
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
