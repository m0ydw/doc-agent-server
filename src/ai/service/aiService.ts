/**
 * AI 服务层 - 运行 Agent 流式输出
 */

import { Request, Response } from "express";
import { createZhipuAI } from "../core/aiWrapper/zhipuAI";
import { createSingleDocAgent } from "../agent/singleAgent";

async function runAgentStream(req: Request, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  req.on("close", function() {
    console.log("Client closed connection");
  });

  try {
    var body = req.body;
    var user_input = body.user_input;
    var doc_path = body.doc_path;
    var docId = body.doc_id || "default";
    var model_config = body.model_config || {};

    var apiKey = process.env.ZHIPUAI_API_KEY;
    if (!apiKey) {
      res.status(500).write("错误: 未配置 ZHIPUAI_API_KEY");
      res.end();
      return;
    }

    var llm = createZhipuAI({
      apiKey: apiKey,
      modelName: model_config.model || "glm-4-flash",
      temperature: model_config.temperature || 0.1,
    });

    var agent = createSingleDocAgent(llm, docId, doc_path);

    var stream = agent.streamRun(user_input);
    for await (var chunk of stream) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error("Agent 运行失败:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write("\n错误: " + error.message);
      res.end();
    }
  }
}

export { runAgentStream };