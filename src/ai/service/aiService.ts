/**
 * AI 服务层 - 使用全局 Agent 处理用户消息，SSE 流式返回
 */

import { Request, Response } from "express";
import { getGlobalAgent } from "../agent/globalAgent";
import type { LLMProvider } from "../core/llm";

import { sseError } from "../core/sseEmitter";

/**
 * 向全局 Agent 发送消息，SSE 流式返回
 * POST /api/ai/agent/message
 */
async function runAgentMessage(req: Request, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  req.on("close", function () {
    console.log("[aiService] 客户端断开连接");
  });

  try {
    const body = req.body;
    const message = body.message;
    const contextDocId = body.contextDocId;
    const mode: "workflow" | "chat" = (body.mode === "chat" ? "chat" : "workflow");
    const modelConfig = body.modelConfig as { provider?: string; apiKey?: string; model?: string; modelKwargs?: Record<string, any> } | undefined;

    // 映射前端字段到 GlobalAgentConfig
    const agentConfig = modelConfig ? {
      provider: modelConfig.provider as any,
      apiKey: modelConfig.apiKey,
      modelName: modelConfig.model,
      modelKwargs: modelConfig.modelKwargs,
    } : undefined;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      res.status(400).write(sseError("message 不能为空"));
      res.end();
      return;
    }

    const agent = getGlobalAgent();

    if (!agent.isInitialized) {
      agent.initialize(agentConfig);
      if (!agent.isInitialized) {
        res.status(500).write(sseError("Agent 未初始化，请配置 API Key（检查 .env 文件）"));
        res.end();
        return;
      }
    } else if (agentConfig?.provider) {
      // 如果客户端指定了不同厂商，重新初始化
      agent.reinitialize(agentConfig);
    }

    const stream = agent.streamProcess({
      message: message,
      contextDocId: contextDocId,
      mode: mode,
    });

    for await (const chunk of stream) {
      if (res.writableEnded) break;
      res.write(chunk);
    }

    res.end();
  } catch (error: any) {
    console.error("[aiService] Agent 运行失败:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(sseError(error.message));
      res.end();
    }
  }
}

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

export { runAgentMessage, getAgentStatus, resetAgent, setAgentConfig };
