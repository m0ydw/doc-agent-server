// 引入 config（统一读取配置）
const express = require("express");
const path = require("path");
const Y = require("yjs");
const { Server } = require("@hocuspocus/server");
const config = require("./config");

// 引入 app
const app = require("./app");
const docRoutes = require("./routes/docRoutes");
const docOperationsRoutes = require("./routes/docOperationsRoutes");
const { UPLOAD_DIR } = require("./services/docServices");
const { openDocument, closeDocument } = require("./services/cliRunner");

// 静态文件服务 - 提供上传文件的访问
app.use("/uploads", express.static(UPLOAD_DIR));

// ------------ 文档管理路由 ------------
app.use("/api/docs", docRoutes);
// -------------------------------------------

// ------------ 文档操作路由 ------------
app.use("/api/doc-operations", docOperationsRoutes);
// -------------------------------------------

// 从 config 里拿端口 ✅
const PORT = config.PORT;

// 启动 HTTP 服务
app.listen(PORT, () => {
  console.log("Node 后端已启动");
  console.log(`地址：http://localhost:${PORT}`);
  console.log(`对接 Python AI：${config.PYTHON_API_URL}`);
});

// ------------ Yjs 文档缓存 ------------
// 缓存 docId -> { doc, docPath }
const yjsDocCache = new Map();

/**
 * 加载或创建 Yjs 文档
 * @param {string} docId - 文档 ID
 * @returns {Promise<object>} - Yjs 文档
 */
async function getOrCreateYjsDoc(docId) {
  // 检查缓存
  if (yjsDocCache.has(docId)) {
    console.log("[Hocuspocus] 使用缓存的 Yjs 文档:", docId);
    return yjsDocCache.get(docId).doc;
  }

  console.log("[Hocuspocus] 加载文档:", docId);

  // 使用 SDK 打开文档
  const docPath = path.join(UPLOAD_DIR, `${docId}.docx`);
  const doc = await openDocument(docPath);

  // 等待 SDK 完成转换（最多等待 10 秒）
  console.log("[Hocuspocus] 等待 SDK 转换完成...");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log("[Hocuspocus] 等待超时，继续...");
      resolve();
    }, 10000);

    // 等待 doc 对象的 ready 事件或超时
    if (doc.ready) {
      clearTimeout(timeout);
      resolve();
    } else {
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 5000);
    }
  });

  // 获取 Yjs 文档
  const ydoc = doc.ydoc;

  // 缓存
  yjsDocCache.set(docId, { doc, docPath });
  console.log("[Hocuspocus] 文档已加载:", docId);

  return ydoc;
}

// ------------ Hocuspocus Yjs WebSocket 服务（独立端口）------------
const hocuspocus = new Server({
  port: 1234,

  // 文档加载回调
  onLoadDocument: async (data) => {
    const docName = data.documentName;
    console.log("[Hocuspocus] 加载文档:", docName);

    try {
      const ydoc = await getOrCreateYjsDoc(docName);
      console.log("[Hocuspocus] Yjs 文档已就绪:", docName);
      return ydoc;
    } catch (e) {
      console.error("[Hocuspocus] 加载失败:", e.message);
      // 返回一个新文档
      return new Y.Doc();
    }
  },

  // 连接回调
  onConnect: async (data) => {
    console.log("[Hocuspocus] 新连接:", data.documentName);
  },

  // 同步回调
  onSync: async (data) => {
    console.log("[Hocuspocus] 同步完成:", data.documentName);
  },

  // 文档变化回调
  onChange: async (data) => {
    console.log("[Hocuspocus] 文档变化:", data.documentName);
  },
});

hocuspocus.listen();
console.log("Hocuspocus Yjs 服务已启动");
console.log("协作地址：ws://localhost:1234");
// -------------------------------------------------