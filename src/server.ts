/**
 * ============================================================
 * 【后端主入口文件 - server.ts】
 * ============================================================
 *
 * 【链路式工程流说明】
 * 这是后端服务的主入口文件，负责：
 * 1. 组装所有子系统（Express、WebSocket、协作服务）
 * 2. 启动HTTP服务
 * 3. 启动Agent WebSocket服务
 * 4. 启动协作服务
 * 5. 初始化文件清理策略
 * 6. 初始化文件注册表
 *
 * 【启动顺序】
 * 1. Express HTTP服务启动
 * 2. 文件清理策略执行
 * 3. 文件注册表初始化
 * 4. 协作服务启动
 *
 * 【架构说明】
 * - HTTP服务: 处理REST API请求（文档管理、操作）
 * - Agent WebSocket: 处理AI Agent的实时通信
 * - 协作服务: 处理多端实时协作编辑
 *
 * 【端口分配】
 * - HTTP服务: config.PORT（默认3000）
 * - 协作服务: config.COLLAB_WS_PORT（默认1234）
 *
 * 【使用的库】
 * express: Web应用框架
 *   - 路由处理
 *   - 中间件支持
 *   - 静态文件服务
 *
 * ws: WebSocket库
 *   - WebSocketServer: WebSocket服务器
 *   - 处理WebSocket连接
 *
 * @superdoc-dev/superdoc-yjs-collaboration: 协作服务库
 *   - CollaborationBuilder: 协作服务构建器
 *   - 管理Yjs文档的协作编辑
 *
 * fs: Node.js文件系统模块
 *   - 文件操作（读取、删除、统计）
 *
 * path: Node.js路径模块
 *   - 路径处理（拼接、解析）
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【Express框架】
// Web应用框架，用于创建HTTP服务器
// - express(): 创建Express应用实例
// - express.static(): 静态文件服务中间件
import express from "express";

// 【WebSocket库】
// WebSocket服务器库，用于创建WebSocket服务
// - WebSocketServer: WebSocket服务器类
import { WebSocketServer } from "ws";

// 【协作服务库】
// SuperDoc的Yjs协作服务库
// - CollaborationBuilder: 协作服务构建器
// - 用于创建和管理Yjs文档的协作编辑服务
import { CollaborationBuilder } from "@superdoc-dev/superdoc-yjs-collaboration";

// 【应用配置】
// 导入配置，包含端口、路径等配置项
import config from "./config";

// 【Express应用实例】
// 从app.ts导入已配置好的Express应用
// 包含中间件、错误处理等配置
import app, { logger } from "./app";

// 【路由模块】
// 文档管理路由（上传、列表、删除、清理）
import docRoutes from "./routes/docRoutes";
// 文档操作路由（查找、替换、文本提取）
import docOperationsRoutes from "./routes/docOperationsRoutes";

// 【服务模块】
// 上传目录路径
import { UPLOAD_DIR } from "./services/docServices";
// 协作状态服务（加载、保存协作状态）
import {
  loadCollabState,
  saveCollabState,
} from "./services/collabStateService";

// 【中间件】
// 认证中间件，用于保护静态文件访问
import { requiresAuth } from "./middleware/auth";

// 【Agent WebSocket模块】
// Agent WebSocket是AI Agent与前端通信的核心通道
// - 前端通过WebSocket发送任务指令
// - 后端通过WebSocket实时推送Agent执行进度
// - 支持人机协作（审批、取消等）
import { attachAgentWebSocket } from "./services/agent/agentWs";

// ================================================================
// 【路由挂载】
// ================================================================

/**
 * 【静态文件服务】
 *
 * 【功能说明】
 * 将uploads目录通过HTTP静态服务暴露给前端
 * 使用轻量认证中间件防止外部直接访问敏感文件
 *
 * 【执行流程】
 * 前端请求/uploads/* → requiresAuth中间件验证
 *   ↓
 * 验证通过 → express.static提供文件服务
 *   ↓
 * 返回文件内容
 */
app.use("/uploads", requiresAuth, express.static(UPLOAD_DIR));

/**
 * 【API路由挂载】
 *
 * 【功能说明】
 * 将文档管理和操作的路由挂载到Express应用
 *
 * 【路由说明】
 * /api/docs: 文档管理路由
 *   - POST /upload: 上传文档
 *   - GET /list: 获取文档列表
 *   - DELETE /:id: 删除文档
 *   - POST /cleanup: 批量清理
 *
 * /api/doc-operations: 文档操作路由
 *   - POST /find: 查找文本
 *   - POST /replace: 替换文本
 *   - GET /text/:id: 获取纯文本
 */
app.use("/api/docs", docRoutes);
app.use("/api/doc-operations", docOperationsRoutes);

// ================================================================
// 【HTTP服务启动】
// ================================================================

/**
 * 【启动HTTP服务】
 *
 * 【功能说明】
 * 启动Express HTTP服务器
 * 监听指定端口，处理HTTP请求
 *
 * 【执行流程】
 * 获取端口配置 → 调用app.listen()
 *   ↓
 * 服务器开始监听 → 回调函数执行
 *   ↓
 * 输出启动日志
 */
const PORT = config.PORT;
const server = app.listen(PORT, () => {
  logger.info(`Node 后端已启动，地址：http://localhost:${PORT}`);
});

// ================================================================
// 【Agent WebSocket服务启动】
// ================================================================

/**
 * 【启动Agent WebSocket服务】
 *
 * 【功能说明】
 * 将WebSocket服务器挂载到HTTP服务器上，路径为/ws/agent
 * 前端可以通过ws://localhost:3000/ws/agent连接到Agent
 *
 * 【WebSocket与HTTP共享端口的优势】
 * - 不需要额外的端口，简化部署
 * - 可以复用HTTP的认证中间件
 * - 前端只需要知道一个地址
 *
 * 【通信协议】
 * 所有消息都是JSON格式，包含type字段标识消息类型：
 *
 * 前端 → 后端：
 * - agent.start: 启动Agent任务
 * - agent.cancel: 取消正在运行的任务
 * - agent.approval.resolve: 处理审批请求
 * - agent.replay: 重新播放事件（用于页面刷新后恢复状态）
 *
 * 后端 → 前端：
 * - agent.started: Agent已启动
 * - agent.trace: 思考过程
 * - tool.started/tool.finished: 工具调用
 * - agent.message.delta: 流式文本片段
 * - approval.requested: 需要审批
 * - approval.resolved: 审批已处理
 * - agent.finished/agent.error: 任务结束
 */
attachAgentWebSocket(server);
logger.info(`Agent WebSocket 已启动：ws://localhost:${PORT}/ws/agent`);

// ================================================================
// 【文件清理策略】
// ================================================================

/**
 * 【文件清理策略说明】
 *
 * 【两种模式】
 * 1. CLEANUP_ON_START=true → 启动时全量删除（开发环境用）
 *    - 每次重启清空测试数据
 *    - 避免残留文件干扰新的操作
 *
 * 2. CLEANUP_ON_START未设 → 定时清理过期文件（生产默认）
 *    - 清理超过MAX_FILE_AGE_HOURS的文件
 *    - 防止磁盘被历史上传文件占满
 *
 * 【目的】
 * - 防止磁盘被历史上传文件占满
 * - 避免残留文件干扰新的操作
 */

// 【导入文件系统模块】
import fs from "fs";
import path from "path";

// 【配置常量】
// 文件最大保留时长（小时），超期自动删除
const MAX_FILE_AGE_HOURS = Number(process.env.MAX_FILE_AGE_HOURS) || 24;
// 定时清理间隔（毫秒），默认每60分钟扫描一次
const CLEANUP_INTERVAL_MS =
  (Number(process.env.CLEANUP_INTERVAL_MINUTES) || 60) * 60 * 1000;
// 是否在启动时全量清理
const FULL_CLEANUP_ON_START = process.env.CLEANUP_ON_START === "true";

/**
 * 【全量删除目录下所有文件】
 *
 * 【功能说明】
 * 删除指定目录下的所有文件（不删除子目录）
 * 用于开发环境启动时清空uploads目录
 *
 * 【执行流程】
 * 1. 检查目录是否存在
 * 2. 读取目录下的所有文件
 * 3. 遍历文件，判断是否为文件（非目录）
 * 4. 删除文件
 * 5. 返回删除的文件数
 *
 * 【容错处理】
 * 单文件删除失败不中断整个清理流程
 * 确保尽可能多的文件被处理
 *
 * @param dir - 目标目录路径
 * @returns 实际删除的文件数
 */
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
      // 单文件删除失败不中断整个清理流程
    }
  }
  return count;
}

/**
 * 【定时清理过期文件】
 *
 * 【功能说明】
 * 遍历uploads目录，删除超过MAX_FILE_AGE_HOURS的文件
 * 设计为无返回值、无异常的容错函数
 *
 * 【执行流程】
 * 1. 获取uploads目录路径
 * 2. 检查目录是否存在
 * 3. 读取目录下的所有文件
 * 4. 遍历文件，计算文件年龄
 * 5. 删除超过阈值的文件
 * 6. 输出清理日志
 *
 * 【容错处理】
 * 即使某文件删除失败也不影响后续文件
 */
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
      `[清理] 已删除 ${deletedCount} 个过期文件（>${MAX_FILE_AGE_HOURS}h）`,
    );
  }
}

/**
 * 【执行清理策略】
 *
 * 【功能说明】
 * 根据配置执行相应的清理策略
 *
 * 【开发模式】
 * CLEANUP_ON_START=true时，启动时全量清空uploads目录
 * 避免上次运行的残留文件干扰本轮调试
 *
 * 【生产模式】
 * CLEANUP_ON_START未设时，首次启动立即运行一次过期清理
 * 之后按CLEANUP_INTERVAL_MS定时扫描
 * 即使服务长时间运行也能持续回收磁盘空间
 */
if (FULL_CLEANUP_ON_START) {
  const deleted = removeAllFiles(path.resolve(UPLOAD_DIR));
  if (deleted > 0) {
    logger.info(`[清理] CLEANUP_ON_START=true，已清空 ${deleted} 个残留文件`);
  }
} else {
  cleanupExpiredFiles();
  setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL_MS);
}

// ================================================================
// 【文件注册表初始化】
// ================================================================

/**
 * 【初始化文件注册表】
 *
 * 【功能说明】
 * 初始化文件注册表，确保服务启动时就能通过注册表查询到已有文档
 *
 * 【执行流程】
 * 1. 导入initFileRegistry函数
 * 2. 调用initFileRegistry()初始化注册表
 *
 * 【注意】
 * 文件注册表初始化必须在路由注册之后
 */
import { initFileRegistry } from "./services/fileRegistry";
void initFileRegistry();

// ================================================================
// 【协作服务启动】
// ================================================================

/**
 * 【SuperDoc Yjs协作服务】
 *
 * 【功能说明】
 * 使用独立端口，通过y-websocket协议提供协作编辑服务
 * 前端编辑器通过此服务与SDK Agent共享同一份Yjs文档数据
 *
 * 【为什么选择独立端口？】
 * - 避免与HTTP端口冲突
 * - 便于单独扩展
 * - 协议不同（WebSocket vs HTTP）
 *
 * 【协作流程】
 * 1. 前端连接协作服务，加入文档房间
 * 2. Agent SDK连接同一房间
 * 3. 任何一方的编辑操作都会同步到另一方
 * 4. Yjs的CRDT算法自动解决冲突
 *
 * 【CollaborationBuilder配置】
 * - withName: 服务名称
 * - withDebounce: 防抖延迟（毫秒）
 * - withDocumentExpiryMs: 文档过期时间（毫秒）
 * - onLoad: 加载文档状态的回调
 * - onAutoSave: 自动保存文档状态的回调
 */
const collaborationService = new CollaborationBuilder()
  .withName("doc-agent-collab")
  .withDebounce(500)
  .withDocumentExpiryMs(30 * 60 * 1000)
  .onLoad(async ({ documentId }) => {
    const state = await loadCollabState(documentId);
    if (state) {
      logger.info(
        `[Collab] loaded persisted state room=${documentId} bytes=${state.byteLength}`,
      );
    }
    return state;
  })
  .onAutoSave(async (params) => {
    await saveCollabState(params);
    logger.info(`[Collab] autosaved room=${params.documentId}`);
  })
  .build();

/**
 * 【创建WebSocket服务器】
 *
 * 【功能说明】
 * 创建WebSocket服务器，监听独立端口
 * 处理协作连接
 */
const wss = new WebSocketServer({ port: config.COLLAB_WS_PORT });

/**
 * 【处理新连接】
 *
 * 【功能说明】
 * 新连接到达时，从URL path中提取房间名
 * 每个房间对应一个文档，同一房间内的连接共享协作状态
 *
 * 【URL格式】
 * ws://host:port/roomName
 * slice(1)去掉开头的"/"
 *
 * 【执行流程】
 * 1. 解析URL获取房间名
 * 2. 注册close和error事件处理
 * 3. 输出连接日志
 * 4. 将连接交给SuperDocCollaboration管理
 */
wss.on("connection", (ws, req) => {
  const roomName = req.url?.slice(1) || "default";

  // 【注册事件处理】
  ws.on("close", (code, reason) => {
    logger.info(
      `[Collab] socket closed room=${roomName} code=${code} reason=${reason.toString()}`,
    );
  });
  ws.on("error", (error) => {
    logger.error(`[Collab] socket error room=${roomName}: ${error.message}`);
  });
  logger.info(`[Collab] 新连接: ${roomName}`);

  // 【将连接交给协作服务管理】
  // 自动处理Yjs同步与冲突解决
  collaborationService.welcome(ws as any, {
    url: req.url ?? "/",
    params: { documentId: roomName },
    headers: req.headers,
  });
});

/**
 * 【协作服务错误处理】
 *
 * 【功能说明】
 * 处理协作服务级别的错误
 * 不会因单连接异常导致整个服务崩溃
 */
wss.on("error", (err) => {
  logger.error(`[Collab] 服务器错误: ${err.message}`);
});

// 【输出启动日志】
logger.info(`SuperDoc 协作服务已启动（端口 ${config.COLLAB_WS_PORT}）`);
logger.info(`协作地址：${config.COLLAB_WS_URL}`);
