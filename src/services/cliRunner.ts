// SDK 客户端单例管理 — 全局只有一个 SDK 客户端实例
// 为什么用单例：SDK 客户端创建开销较大（连接、握手），复用可提升性能
// 为什么需要并发保护：多个请求可能同时触发客户端创建，需防止重复创建

import path from "path";
import type {
  DocOpenParams,
  SuperDocClient,
  SuperDocDocument,
} from "@superdoc-dev/sdk";

// uploads 目录的绝对路径，所有文档文件存放在此
const DOCS_DIR = path.join(__dirname, "../../uploads");

// SDK 客户端状态变量
let client: SuperDocClient | null = null; // 客户端实例（单例）
let isConnected = false; // 连接状态标记
let connectPromise: Promise<SuperDocClient> | null = null; // 并发保护：正在进行中的连接 Promise

// getClient — 获取或创建 SDK 客户端单例
// 使用 Promise 锁机制防止并发调用导致重复创建
// 返回已连接的 SDK 客户端实例
async function getClient(): Promise<SuperDocClient> {
  // 如果已有已连接的客户端，直接复用
  if (client && isConnected) {
    return client;
  }

  // 如果正在连接中，复用同一个 Promise — 这就是并发保护的锁机制
  if (connectPromise) {
    return connectPromise;
  }

  // 创建新的连接 Promise
  connectPromise = (async () => {
    // 动态导入 SDK，避免启动时因 SDK 缺失导致整个服务崩溃
    const { createSuperDocClient } = await import("@superdoc-dev/sdk");

    // 创建客户端并配置超时参数
    // requestTimeoutMs=90000（90秒）：AI Agent 操作（如查找/替换）可能需要较长时间
    // watchdogTimeoutMs=90000（90秒）：心跳看门狗超时，协作连接不活跃时触发
    // SUPERDOC_DEBUG_TEXT_REWRITE 开启文本重写调试模式
    client = createSuperDocClient({
      env: {
        SUPERDOC_DEBUG_TEXT_REWRITE: "1",
      },
      user: { name: "Agent", email: "agent@local" },
      requestTimeoutMs: 90000,
      watchdogTimeoutMs: 90000,
    });

    await client.connect();
    isConnected = true;
    console.log("[SDK] Client connected (timeout=90s)");
    return client;
  })();

  try {
    const result = await connectPromise;
    connectPromise = null; // 连接完成后清空锁
    return result;
  } catch (error) {
    connectPromise = null; // 连接失败也要清空锁，允许下次重试
    throw error;
  }
}

// disposeClient — 销毁 SDK 客户端，释放所有资源
// 通常在 cleanup 流程中调用，或连接超时后重置
async function disposeClient(): Promise<void> {
  if (client) {
    await client.dispose();
    client = null;
    isConnected = false;
    console.log("[SDK] Client disposed");
  }
}

// 打开文档时的参数接口 — 支持独立模式和协作模式
export interface OpenParams {
  docPath: string; // 文档文件在磁盘上的路径
  sessionId?: DocOpenParams["sessionId"]; // 会话 ID，用于标识本次编辑会话
  collabUrl?: DocOpenParams["collabUrl"]; // 协作 WebSocket 服务地址（如 ws://localhost:1234）
  collabDocumentId?: DocOpenParams["collabDocumentId"]; // 协作房间名/文档 ID，对应 y-websocket room
  onMissing?: DocOpenParams["onMissing"]; // 文档不存在时的处理策略
  bootstrapSettlingMs?: DocOpenParams["bootstrapSettlingMs"]; // 引导数据稳定等待时间
}

// openDocument — 打开一个文档并返回文档句柄
// 支持两种模式：
//   1. 独立模式：只传 docPath 和 sessionId
//   2. 协作模式：额外传 collabUrl + collabDocumentId，Agent 通过 y-websocket 加入协作房间
// 协作模式下 Agent 与前端编辑器共享同一份 Yjs 数据，编辑可实时同步
async function openDocument(params: OpenParams): Promise<SuperDocDocument> {
  const {
    docPath,
    sessionId,
    collabUrl,
    collabDocumentId,
    onMissing,
    bootstrapSettlingMs,
  } = params;
  const sdkClient = await getClient();

  // 构造打开文档的 payload
  const openPayload: DocOpenParams = { doc: docPath };

  if (sessionId) {
    openPayload.sessionId = sessionId;
  }

  // 如果提供了协作参数，则以协作模式打开
  // collabUrl + collabDocumentId 是 y-websocket 协议的缩略参数写法
  // SDK 内部会自动处理 y-websocket 连接和 Yjs 同步
  if (collabUrl) {
    openPayload.collabUrl = collabUrl;
    if (collabDocumentId) openPayload.collabDocumentId = collabDocumentId;
    if (onMissing) openPayload.onMissing = onMissing;
    if (bootstrapSettlingMs)
      openPayload.bootstrapSettlingMs = bootstrapSettlingMs;
  }

  const doc = await sdkClient.open(openPayload);
  console.log(
    `[SDK] Document opened: ${docPath} room=${collabDocumentId ?? "none"}`,
  );
  return doc;
}

export type RoomDocument = Awaited<ReturnType<typeof openDocument>>;

export type RoomSessionResult = {
  sessionId: string;
  doc: RoomDocument;
};

// closeDocument — 关闭文档句柄，释放 SDK 资源
async function closeDocument(doc: RoomDocument | null): Promise<void> {
  if (doc) {
    await doc.close();
    console.log("[SDK] Document closed");
  }
}

export { disposeClient, openDocument, closeDocument, DOCS_DIR };
