import { Request, Response, NextFunction } from "express";

/**
 * 轻量级认证中间件
 * 检查请求头中的 X-Internal-Token 或开发环境跳过
 */
export function requiresAuth(req: Request, res: Response, next: NextFunction): void {
  // 开发环境跳过认证
  if (process.env.NODE_ENV === "development" || !process.env.NODE_ENV) {
    return next();
  }

  const token = req.headers["x-internal-token"] as string | undefined;
  const expectedToken = process.env.INTERNAL_TOKEN || "docagent-internal";

  if (token === expectedToken) {
    return next();
  }

  res.status(401).json({ success: false, message: "未授权访问" });
}
