/**
 * AI 服务层 — 状态查询与配置（消息推送已迁移至 WebSocket）
 */

import { Request, Response } from "express";
import { getGlobalAgent } from "../agent/globalAgent";

/**
 * 查询 Agent 状态
 * GET /api/ai/agent/status
 */
function getAgentStatus(req: Request, res: Response): void {
  const agent = getGlobalAgent();
  const status = agent.getStatus();
  res.json({
    success: true,
    data: {
      initialized: status.initialized,
      availableDocs: status.docCount,
      memoryEntries: status.memoryLength,
    },
  });
}

/**
 * 重置 Agent 记忆
 * POST /api/ai/agent/reset
 */
function resetAgent(req: Request, res: Response): void {
  const agent = getGlobalAgent();
  agent.reset();
  res.json({
    success: true,
    message: "Agent 记忆已重置",
  });
}

/**
 * 设置 Agent LLM 配置（立即重新初始化）
 * POST /api/ai/agent/config
 */
function setAgentConfig(req: Request, res: Response): void {
  try {
    const body = req.body;
    const provider = body.provider;
    const apiKey = body.apiKey;
    const model = body.model;
    const modelKwargs = body.modelKwargs;

    if (!provider) {
      res.status(400).json({ success: false, error: "provider 不能为空" });
      return;
    }

    const agent = getGlobalAgent();
    agent.reinitialize({
      provider: provider as any,
      apiKey: apiKey || undefined,
      modelName: model || undefined,
      modelKwargs: modelKwargs || undefined,
    });

    console.log("[aiService] LLM 配置已更新: provider=" + provider + ", model=" + (model || "default"));
    res.json({ success: true });
  } catch (error: any) {
    console.error("[aiService] 设置 Agent 配置失败:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export { getAgentStatus, resetAgent, setAgentConfig };
