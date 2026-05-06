/**
 * AI 路由（仅保留状态/配置接口，消息推送已迁移至 WebSocket）
 */

import { Router, Request, Response } from "express";
import { getAgentStatus, resetAgent, setAgentConfig } from "../ai/service/aiService";

const router: Router = Router();

// 查询 Agent 状态
router.get("/agent/status", function (req: Request, res: Response) {
  getAgentStatus(req, res);
});

// 重置 Agent 记忆
router.post("/agent/reset", function (req: Request, res: Response) {
  resetAgent(req, res);
});

// 设置 Agent LLM 配置
router.post("/agent/config", function (req: Request, res: Response) {
  setAgentConfig(req, res);
});

export default router;
