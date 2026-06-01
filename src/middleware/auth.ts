/**
 * ============================================================
 * 【轻量级认证中间件 - auth.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是轻量级认证中间件，负责：
 * 1. 保护uploads静态目录等内部资源
 * 2. 验证请求头中的X-Internal-Token
 * 3. 在开发环境跳过认证
 * 4. 在生产环境验证Token
 * 
 * 【架构位置】
 * 前端请求 → Express路由 → 【auth.ts】 → 静态文件服务
 * 
 * 【数据流】
 * 前端请求/uploads/* → requiresAuth中间件
 *   ↓
 * 检查环境变量NODE_ENV
 *   ↓
 * 开发环境：跳过认证，直接放行
 *   ↓
 * 生产环境：验证X-Internal-Token头
 *   ↓
 * Token匹配：放行
 *   ↓
 * Token不匹配：返回401
 * 
 * 【设计思路】
 * 当前系统是单机工具，不需要复杂的用户体系
 * 轻量Token即可防止外部直接扫描uploads
 * 
 * 【使用的库】
 * express: Web应用框架
 *   - Request: 请求对象
 *   - Response: 响应对象
 *   - NextFunction: 下一个中间件函数
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【Express框架】
// 导入Express的类型定义
import { Request, Response, NextFunction } from "express";

// ================================================================
// 【中间件函数】
// ================================================================

/**
 * 【requiresAuth中间件】
 * 
 * 【功能说明】
 * 验证请求头中的X-Internal-Token
 * 在开发环境或NODE_ENV未设置时跳过认证
 * 在生产环境：Token必须匹配INTERNAL_TOKEN环境变量值
 * 
 * 【设计目的】
 * 允许开发时自由访问uploads
 * 生产时通过简单Token控制访问
 * 
 * 【执行流程】
 * 1. 检查NODE_ENV环境变量
 * 2. 如果是development或未设置，跳过认证
 * 3. 获取请求头中的X-Internal-Token
 * 4. 获取期望的Token值
 * 5. 比较Token
 * 6. 匹配则放行，不匹配返回401
 * 
 * @param req - 请求对象
 * @param res - 响应对象
 * @param next - 下一个中间件函数
 */
export function requiresAuth(req: Request, res: Response, next: NextFunction): void {
  // 【开发环境跳过认证】
  // 避免本地调试时需要手动设置Token
  if (process.env.NODE_ENV === "development" || !process.env.NODE_ENV) {
    return next();
  }

  // 【获取请求头中的Token】
  const token = req.headers["x-internal-token"] as string | undefined;
  
  // 【获取期望的Token值】
  // 默认Token值，生产环境应通过环境变量覆盖
  const expectedToken = process.env.INTERNAL_TOKEN || "docagent-internal";

  // 【Token匹配则放行】
  if (token === expectedToken) {
    return next();
  }

  // 【不匹配时返回401】
  // 阻止未授权访问
  res.status(401).json({ success: false, message: "未授权访问" });
}
