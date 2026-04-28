/**
 * AI 服务层 - 使用全局 Agent 处理用户消息，SSE 流式返回
 */

import { Request, Response } from "express";
import { getGlobalAgent } from "../agent/globalAgent";

/**
 * 向全局 Agent 发送消息，SSE 流式返回
 * POST /api/ai/agent/message
 */
async function runAgentMessage(req: Request, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  req.on("close", function () {
    console.log("[aiService] 客户端断开连接");
  });

  try {
    var body = req.body;
    var message = body.message;
    var contextDocId = body.contextDocId;
    var mode: "workflow" | "chat" = (body.mode === "chat" ? "chat" : "workflow");

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      res.status(400).write("错误: message 不能为空");
      res.end();
      return;
    }

    var agent = getGlobalAgent();

    if (!agent.isInitialized) {
      agent.initialize();
      if (!agent.isInitialized) {
        res.status(500).write("错误: Agent 未初始化，请配置 API Key（检查 .env 文件）");
        res.end();
        return;
      }
    }

    var stream = agent.streamProcess({
      message: message,
      contextDocId: contextDocId,
      mode: mode,
    });

    for await (var chunk of stream) {
      if (res.writableEnded) break;
      res.write(chunk);
    }

    res.end();
  } catch (error: any) {
    console.error("[aiService] Agent 运行失败:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write("\n错误: " + error.message);
      res.end();
    }
  }
}

/**
 * 查询 Agent 状态
 * GET /api/ai/agent/status
 */
function getAgentStatus(req: Request, res: Response): void {
  var agent = getGlobalAgent();
  var status = agent.getStatus();
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
  var agent = getGlobalAgent();
  agent.reset();
  res.json({
    success: true,
    message: "Agent 记忆已重置",
  });
}

export { runAgentMessage, getAgentStatus, resetAgent };
