import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { Writable } from "stream";
import config from "./config";

// ================================================================
// 日志 — 自定义轻量 pretty-print（Windows 终端编码友好）
// ================================================================

const prettyStream = new Writable({
  write(
    chunk: string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      const obj = JSON.parse(chunk);
      const time = new Date(obj.time).toLocaleTimeString("zh-CN", { hour12: false });
      const level = obj.level >= 50 ? "FATAL" : obj.level >= 40 ? "ERROR" : obj.level >= 30 ? "WARN " : "INFO ";
      const msg = obj.msg || "";
      const err = obj.err ? " " + (obj.err.message || obj.err) : "";
      // 直接使用 console.log，Node.js 内部会正确处理 Windows 编码
      console.log(`[${time}] ${level} ${msg}${err}`);
    } catch {
      // JSON 解析失败时原样输出
      console.log(chunk);
    }
    callback();
  },
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: true,
  },
  prettyStream
);

// ================================================================
// App
// ================================================================

const app: Express = express();

// 安全头
app.use(helmet());

// CORS（开发环境允许常见来源，生产环境通过 CORS_ORIGINS 环境变量配置白名单）
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

// 速率限制（可通过环境变量调整）
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "请求过于频繁，请稍后重试" },
});
app.use(limiter);

// Body 解析
app.use(
  express.json({
    verify: function (req: Request, _res: Response, buf: Buffer) {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    verify: function (req: Request, _res: Response, buf: Buffer) {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  })
);

// 请求日志中间件
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, url: req.url }, "请求");
  next();
});

export default app;
