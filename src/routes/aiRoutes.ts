/**
 * AI 路由
 */

import { Router, Request, Response } from "express";
import { runAgentMessage, getAgentStatus, resetAgent } from "../ai/service/aiService";

const router: Router = Router();

// 向全局 Agent 发送消息（SSE 流式返回）
router.post("/agent/message", function (req: Request, res: Response) {
  runAgentMessage(req, res);
});

// 查询 Agent 状态
router.get("/agent/status", function (req: Request, res: Response) {
  getAgentStatus(req, res);
});

// 重置 Agent 记忆
router.post("/agent/reset", function (req: Request, res: Response) {
  resetAgent(req, res);
});

export default router;
