// 轻量级认证中间件 — 保护 uploads 静态目录等内部资源
// 设计为简单的 Token 校验，而非完整的用户认证系统
// 原因：当前系统是单机工具，不需要复杂的用户体系，轻量 Token 即可防止外部直接扫描 uploads

import { Request, Response, NextFunction } from "express";

// requiresAuth 中间件 — 验证请求头中的 X-Internal-Token
// 在 development 环境或 NODE_ENV 未设置时跳过认证（开发便利性优先）
// 在 production 环境：Token 必须匹配 INTERNAL_TOKEN 环境变量值
// 这个设计允许开发时自由访问 uploads，生产时通过简单 Token 控制访问
export function requiresAuth(req: Request, res: Response, next: NextFunction): void {
  // 开发环境跳过认证 — 避免本地调试时需要手动设置 Token
  if (process.env.NODE_ENV === "development" || !process.env.NODE_ENV) {
    return next();
  }

  const token = req.headers["x-internal-token"] as string | undefined;
  // 默认 Token 值，生产环境应通过环境变量覆盖
  const expectedToken = process.env.INTERNAL_TOKEN || "docagent-internal";

  // Token 匹配则放行
  if (token === expectedToken) {
    return next();
  }

  // 不匹配时返回 401，阻止未授权访问
  res.status(401).json({ success: false, message: "未授权访问" });
}
