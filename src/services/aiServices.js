const axios = require("axios");
const config = require("../config");

async function runAgentStream(req, res) {
  const { CancelToken } = axios;
  const source = CancelToken.source();

  // 1. 设置 SSE 推荐响应头（或 text/plain 流）
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // 2. 客户端断开监听
  req.on("close", () => {
    source.cancel("Client closed connection");
  });

  try {
    const { user_input, doc_path, model_config } = req.body;
    const response = await axios({
      method: "POST",
      url: `${config.PYTHON_API_URL}/agent/run/stream`,
      data: { user_input, doc_path, model_config },
      responseType: "stream",
      cancelToken: source.token,
      timeout: 0,
      validateStatus: (status) => status === 200, // 只有 200 才算成功
    });

    // 3. 状态检查（这里实际由 validateStatus 保证了）
    // 4. 透传流（自动处理背压）
    response.data.pipe(res);
    // 5. 错误处理
    response.data.on("error", (err) => {
      if (!res.writableEnded) {
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    if (axios.isCancel(err)) {
      console.log("Request canceled:", err.message);
      return;
    }
    // 只有还没发送响应头时才返回错误状态
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.destroy();
    }
  }
}

module.exports = { runAgentStream };
