// Express 应用实例创建与中间件配置
// 中间件加载顺序有讲究：安全头最优先 → CORS 其次 → 速率限制 → Body 解析 → 请求日志
// 这个顺序确保安全/限流在其他逻辑之前生效，同时请求日志能记录到真实请求信息

import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { Writable } from "stream";
import config from "./config";

// 自定义轻量日志打印器 — 将 pino 的 JSON 输出转为 Windows 终端友好的格式
// 为什么不用 pino-pretty：pino-pretty 在 Windows 下有编码和性能问题
// 这里直接用 Writable 流拦截 pino 输出，手动格式化时间/级别/消息
const prettyStream = new Writable({
  write(
    chunk: string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      const obj = JSON.parse(chunk);
      const time = new Date(obj.time).toLocaleTimeString("zh-CN", { hour12: false });
      // pino 日志级别映射：>=50 fatal, >=40 error, >=30 warn, 其余 info
      const level = obj.level >= 50 ? "FATAL" : obj.level >= 40 ? "ERROR" : obj.level >= 30 ? "WARN " : "INFO ";
      const msg = obj.msg || "";
      const err = obj.err ? " " + (obj.err.message || obj.err) : "";
      console.log(`[${time}] ${level} ${msg}${err}`);
    } catch {
      // JSON 解析失败时原样输出，保证不丢失日志内容
      console.log(chunk);
    }
    callback();
  },
});

// 导出全局 logger 实例，供整个项目统一使用
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: true,
  },
  prettyStream
);

// 创建 Express 应用实例
const app: Express = express();

// helmet — 设置多种安全 HTTP 头（如 X-Content-Type-Options、X-Frame-Options 等）
// 放在最前面确保所有响应都带上安全头
app.use(helmet());

// CORS — 控制跨域请求，开发环境允许 localhost:5173（前端）和 localhost:3000（后端）
// 生产环境通过 CORS_ORIGINS 环境变量配置白名单
// allowedHeaders 中包含 X-Original-Filename 以支持前端发送带特殊字符的文件名
const FRONTEND_PORT = process.env.FRONTEND_PORT || "5173";
const allowedOrigins = process.env.CORS_ORIGINS?.split(",") || [
  `http://localhost:${FRONTEND_PORT}`,
  `http://localhost:${config.PORT}`,
];
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-File-Name", "X-Original-Filename"],
  })
);

// express-rate-limit — 防止 API 被恶意高频调用
// 默认窗口 60 秒内最多 120 次请求，可通过环境变量调整以适应不同负载场景
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 120,
  standardHeaders: true,   // 返回 RateLimit-* 标准头，方便前端识别限流状态
  legacyHeaders: false,    // 不返回 X-RateLimit-* 废弃头
  message: { success: false, message: "请求过于频繁，请稍后重试" },
});
app.use(limiter);

// express.json() — 解析 JSON 格式的请求体
// verify 回调中保存 rawBody，供后续需要原始请求体的场景使用（如签名校验）
app.use(
  express.json({
    verify: function (req: Request, _res: Response, buf: Buffer) {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  })
);

// express.urlencoded — 解析 URL 编码的表单数据（extended: true 支持嵌套对象）
app.use(
  express.urlencoded({
    extended: true,
    verify: function (req: Request, _res: Response, buf: Buffer) {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  })
);

// 请求日志中间件 — 记录每个请求的方法和 URL
// 放在最后，确保前面的中间件先完成处理后记录到的才是真实请求信息
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, url: req.url }, "请求");
  next();
});

export default app;
