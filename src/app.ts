/**
 * ============================================================
 * 【Express应用配置 - app.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是Express应用的配置文件，负责：
 * 1. 创建Express应用实例
 * 2. 配置中间件（安全、CORS、限流、日志等）
 * 3. 导出全局logger实例
 * 4. 导出配置好的app实例
 * 
 * 【中间件加载顺序】
 * 中间件加载顺序有讲究：
 * 1. 安全头（helmet）最优先
 * 2. CORS其次
 * 3. 速率限制
 * 4. Body解析
 * 5. 请求日志
 * 
 * 【为什么这个顺序？】
 * - 安全/限流在其他逻辑之前生效
 * - 请求日志能记录到真实请求信息
 * 
 * 【使用的库】
 * express: Web应用框架
 *   - Express: Express应用类型
 *   - Request: 请求对象类型
 *   - Response: 响应对象类型
 *   - NextFunction: 下一个中间件函数类型
 * 
 * cors: 跨域资源共享中间件
 *   - 处理跨域请求
 *   - 配置允许的源、方法、头部
 * 
 * helmet: 安全中间件
 *   - 设置多种安全HTTP头
 *   - 如X-Content-Type-Options、X-Frame-Options等
 * 
 * express-rate-limit: 速率限制中间件
 *   - 防止API被恶意高频调用
 *   - 配置时间窗口和最大请求数
 * 
 * pino: 日志库
 *   - 高性能JSON日志
 *   - 支持结构化日志
 * 
 * stream: Node.js流模块
 *   - Writable: 可写流
 *   - 用于自定义日志输出
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【Express框架】
// 导入Express及其类型定义
import express, { Express, Request, Response, NextFunction } from "express";

// 【CORS中间件】
// 处理跨域资源共享
// 允许前端从不同源访问后端API
import cors from "cors";

// 【Helmet安全中间件】
// 设置多种安全HTTP头
// 保护应用免受常见Web攻击
import helmet from "helmet";

// 【速率限制中间件】
// 防止API被恶意高频调用
// 配置时间窗口和最大请求数
import rateLimit from "express-rate-limit";

// 【Pino日志库】
// 高性能JSON日志库
// 支持结构化日志，便于后续分析
import pino from "pino";

// 【Node.js流模块】
// Writable: 可写流
// 用于自定义日志输出格式
import { Writable } from "stream";

// 【应用配置】
// 导入配置，包含端口等配置项
import config from "./config";

// ================================================================
// 【日志配置】
// ================================================================

/**
 * 【自定义轻量日志打印器】
 * 
 * 【功能说明】
 * 将pino的JSON输出转为Windows终端友好的格式
 * 
 * 【为什么不用pino-pretty？】
 * pino-pretty在Windows下有编码和性能问题
 * 这里直接用Writable流拦截pino输出，手动格式化
 * 
 * 【日志格式】
 * [时间] 级别 消息 错误信息
 * 
 * 【执行流程】
 * pino输出JSON → prettyStream拦截
 *   ↓
 * 解析JSON对象 → 提取time、level、msg、err
 *   ↓
 * 格式化输出 → console.log打印
 */
const prettyStream = new Writable({
  /**
   * 【write方法】
   * 
   * 【功能说明】
   * 实现Writable流的write方法
   * 处理pino输出的JSON日志
   * 
   * @param chunk - 日志数据（JSON字符串）
   * @param _encoding - 编码（未使用）
   * @param callback - 完成回调
   */
  write(
    chunk: string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      // 【解析JSON】
      const obj = JSON.parse(chunk);
      
      // 【格式化时间】
      const time = new Date(obj.time).toLocaleTimeString("zh-CN", { hour12: false });
      
      // 【日志级别映射】
      // pino日志级别：>=50 fatal, >=40 error, >=30 warn, 其余 info
      const level = obj.level >= 50 ? "FATAL" : obj.level >= 40 ? "ERROR" : obj.level >= 30 ? "WARN " : "INFO ";
      
      // 【提取消息和错误】
      const msg = obj.msg || "";
      const err = obj.err ? " " + (obj.err.message || obj.err) : "";
      
      // 【输出日志】
      console.log([]  );
    } catch {
      // 【JSON解析失败】
      // 原样输出，保证不丢失日志内容
      console.log(chunk);
    }
    callback();
  },
});

/**
 * 【全局logger实例】
 * 
 * 【功能说明】
 * 导出全局logger实例，供整个项目统一使用
 * 
 * 【配置】
 * - level: 日志级别（默认info）
 * - timestamp: 启用时间戳
 * - prettyStream: 自定义输出流
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: true,
  },
  prettyStream
);

// ================================================================
// 【Express应用创建】
// ================================================================

/**
 * 【创建Express应用实例】
 * 
 * 【功能说明】
 * 创建Express应用实例
 * 后续的中间件和路由都挂载到这个实例上
 */
const app: Express = express();

// ================================================================
// 【中间件配置】
// ================================================================

/**
 * 【Helmet安全中间件】
 * 
 * 【功能说明】
 * 设置多种安全HTTP头
 * 保护应用免受常见Web攻击
 * 
 * 【设置的安全头】
 * - X-Content-Type-Options: nosniff（防止MIME类型嗅探）
 * - X-Frame-Options: DENY（防止点击劫持）
 * - X-XSS-Protection: 0（禁用XSS过滤器）
 * - Strict-Transport-Security: 强制HTTPS
 * - 等等
 * 
 * 【为什么放在最前面？】
 * 确保所有响应都带上安全头
 */
app.use(helmet());

/**
 * 【CORS跨域配置】
 * 
 * 【功能说明】
 * 控制跨域请求
 * 开发环境允许localhost:5173（前端）和localhost:3000（后端）
 * 生产环境通过CORS_ORIGINS环境变量配置白名单
 * 
 * 【配置项】
 * - origin: 允许的源
 * - methods: 允许的HTTP方法
 * - allowedHeaders: 允许的请求头
 * 
 * 【特殊头部】
 * X-Original-Filename: 支持前端发送带特殊字符的文件名
 */
const FRONTEND_PORT = process.env.FRONTEND_PORT || "5173";
const allowedOrigins = process.env.CORS_ORIGINS?.split(",") || [
  http://localhost:,
  http://localhost:,
];
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-File-Name", "X-Original-Filename"],
  })
);

/**
 * 【速率限制中间件】
 * 
 * 【功能说明】
 * 防止API被恶意高频调用
 * 默认窗口60秒内最多120次请求
 * 可通过环境变量调整以适应不同负载场景
 * 
 * 【配置项】
 * - windowMs: 时间窗口（毫秒）
 * - max: 最大请求数
 * - standardHeaders: 返回RateLimit-*标准头
 * - legacyHeaders: 不返回X-RateLimit-*废弃头
 * - message: 超限时的响应消息
 */
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "请求过于频繁，请稍后重试" },
});
app.use(limiter);

/**
 * 【JSON Body解析中间件】
 * 
 * 【功能说明】
 * 解析JSON格式的请求体
 * 
 * 【verify回调】
 * 保存rawBody，供后续需要原始请求体的场景使用（如签名校验）
 */
app.use(
  express.json({
    verify: function (req: Request, _res: Response, buf: Buffer) {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  })
);

/**
 * 【URL编码Body解析中间件】
 * 
 * 【功能说明】
 * 解析URL编码的表单数据
 * extended: true支持嵌套对象
 * 
 * 【verify回调】
 * 保存rawBody，供后续需要原始请求体的场景使用
 */
app.use(
  express.urlencoded({
    extended: true,
    verify: function (req: Request, _res: Response, buf: Buffer) {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  })
);

/**
 * 【请求日志中间件】
 * 
 * 【功能说明】
 * 记录每个请求的方法和URL
 * 放在最后，确保前面的中间件先完成处理后记录到的才是真实请求信息
 * 
 * 【执行流程】
 * 请求到达 → 记录方法和URL → 调用next()
 */
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, url: req.url }, "请求");
  next();
});

// ================================================================
// 【导出】
// ================================================================

/**
 * 【导出Express应用实例】
 * 
 * 【功能说明】
 * 导出配置好的Express应用实例
 * 供server.ts使用，启动HTTP服务
 */
export default app;
