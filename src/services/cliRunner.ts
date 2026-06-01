/**
 * ============================================================
 * 【SDK客户端单例管理 - cliRunner.ts】
 * ============================================================
 *
 * 【链路式工程流说明】
 * 这是SDK客户端单例管理模块，负责：
 * 1. 管理SuperDoc SDK客户端的生命周期
 * 2. 提供客户端的创建、获取、销毁功能
 * 3. 提供文档的打开、关闭功能
 * 4. 支持独立模式和协作模式
 * 5. 并发保护，防止重复创建客户端
 *
 * 【架构位置】
 * sessionManager → 【cliRunner】 → @superdoc-dev/sdk → CLI二进制
 *
 * 【数据流】
 * sessionManager调用openDocument()
 *   ↓
 * getClient()获取或创建SDK客户端
 *   ↓
 * sdkClient.open()打开文档
 *   ↓
 * 返回SuperDocDocument句柄
 *   ↓
 * sessionManager使用句柄进行操作
 *
 * 【为什么用单例？】
 * SDK客户端创建开销较大（连接、握手）
 * 复用可提升性能
 *
 * 【为什么需要并发保护？】
 * 多个请求可能同时触发客户端创建
 * 需防止重复创建
 *
 * 【使用的库】
 * @superdoc-dev/sdk: SuperDoc SDK
 *   - SuperDocClient: SDK客户端类
 *   - SuperDocDocument: 文档句柄类
 *   - createSuperDocClient: 创建客户端的工厂函数
 *   - DocOpenParams: 打开文档的参数类型
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【SDK类型定义】
// 从@superdoc-dev/sdk导入类型定义
// - DocOpenParams: 打开文档的参数类型
// - SuperDocClient: SDK客户端类
// - SuperDocDocument: 文档句柄类
import type {
  DocOpenParams,
  SuperDocClient,
  SuperDocDocument,
} from "@superdoc-dev/sdk";

// ================================================================
// 【SDK客户端状态变量】
// ================================================================

/**
 * 【客户端实例】
 *
 * 【功能说明】
 * 存储SDK客户端的单例实例
 * 全局只有一个客户端实例
 */
let client: SuperDocClient | null = null;

/**
 * 【连接状态标记】
 *
 * 【功能说明】
 * 标记客户端是否已连接
 * 用于快速判断是否需要创建新连接
 */
let isConnected = false;

/**
 * 【并发保护锁】
 *
 * 【功能说明】
 * 存储正在进行中的连接Promise
 * 防止并发调用导致重复创建客户端
 *
 * 【锁机制】
 * 当connectPromise不为null时，表示正在连接中
 * 后续调用会复用这个Promise，而不是创建新连接
 */
let connectPromise: Promise<SuperDocClient> | null = null;

// ================================================================
// 【客户端管理函数】
// ================================================================

/**
 * 【获取或创建SDK客户端】
 *
 * 【功能说明】
 * 获取或创建SDK客户端单例
 * 使用Promise锁机制防止并发调用导致重复创建
 *
 * 【执行流程】
 * 1. 检查是否已有已连接的客户端
 * 2. 如果有，直接复用
 * 3. 如果正在连接中，复用同一个Promise
 * 4. 否则创建新的连接Promise
 * 5. 动态导入SDK（避免启动时因SDK缺失导致整个服务崩溃）
 * 6. 创建客户端并配置超时参数
 * 7. 连接客户端
 * 8. 返回已连接的客户端
 *
 * 【并发保护】
 * 使用connectPromise作为锁
 * 当connectPromise不为null时，表示正在连接中
 * 后续调用会复用这个Promise
 *
 * @returns 已连接的SDK客户端实例
 */
async function getClient(): Promise<SuperDocClient> {
  // 【检查是否已有已连接的客户端】
  if (client && isConnected) {
    return client;
  }

  // 【检查是否正在连接中】
  // 如果正在连接中，复用同一个Promise — 这就是并发保护的锁机制
  if (connectPromise) {
    return connectPromise;
  }

  // 【创建新的连接Promise】
  connectPromise = (async () => {
    // 【动态导入SDK】
    // 避免启动时因SDK缺失导致整个服务崩溃
    const { createSuperDocClient } = await import("@superdoc-dev/sdk");

    // 【创建客户端】
    // 配置超时参数
    // - requestTimeoutMs=90000（90秒）：AI Agent操作可能需要较长时间
    // - watchdogTimeoutMs=90000（90秒）：心跳看门狗超时
    // - SUPERDOC_DEBUG_TEXT_REWRITE: 开启文本重写调试模式
    client = createSuperDocClient({
      env: {
        SUPERDOC_DEBUG_TEXT_REWRITE: "1",
      },
      user: { name: "Agent", email: "agent@local" },
      requestTimeoutMs: 90000,
      watchdogTimeoutMs: 90000,
    });

    // 【连接客户端】
    await client.connect();
    isConnected = true;
    console.log("[SDK] Client connected (timeout=90s)");
    return client;
  })();

  try {
    // 【等待连接完成】
    const result = await connectPromise;
    connectPromise = null; // 连接完成后清空锁
    return result;
  } catch (error) {
    // 【连接失败】
    connectPromise = null; // 连接失败也要清空锁，允许下次重试
    throw error;
  }
}

/**
 * 【销毁SDK客户端】
 *
 * 【功能说明】
 * 销毁SDK客户端，释放所有资源
 * 通常在cleanup流程中调用，或连接超时后重置
 *
 * 【执行流程】
 * 1. 检查客户端是否存在
 * 2. 调用client.dispose()销毁客户端
 * 3. 清空客户端引用
 * 4. 重置连接状态
 */
async function disposeClient(): Promise<void> {
  if (client) {
    await client.dispose();
    client = null;
    isConnected = false;
    console.log("[SDK] Client disposed");
  }
}

// ================================================================
// 【文档操作接口和函数】
// ================================================================

/**
 * 【打开文档参数接口】
 *
 * 【功能说明】
 * 打开文档时的参数接口
 * 支持独立模式和协作模式
 *
 * 【字段说明】
 * @property docPath - 文档文件在磁盘上的路径
 * @property sessionId - 会话ID，用于标识本次编辑会话
 * @property collabUrl - 协作WebSocket服务地址（如ws://localhost:1234）
 * @property collabDocumentId - 协作房间名/文档ID，对应y-websocket room
 */
export interface OpenParams {
  docPath: string;
  sessionId?: DocOpenParams["sessionId"];
  collabUrl?: DocOpenParams["collabUrl"];
  collabDocumentId?: DocOpenParams["collabDocumentId"];
}

/**
 * 【打开文档】
 *
 * 【功能说明】
 * 打开一个文档并返回文档句柄
 * 支持两种模式：
 * 1. 独立模式：只传docPath和sessionId
 * 2. 协作模式：额外传collabUrl + collabDocumentId
 *
 * 【协作模式】
 * Agent通过y-websocket加入协作房间
 * 与前端编辑器共享同一份Yjs数据
 * 编辑可实时同步
 *
 * 【执行流程】
 * 1. 获取SDK客户端
 * 2. 构造打开文档的payload
 * 3. 如果提供了协作参数，以协作模式打开
 * 4. 调用sdkClient.open()打开文档
 * 5. 返回文档句柄
 *
 * @param params - 打开文档的参数
 * @returns 文档句柄
 */
async function openDocument(params: OpenParams): Promise<SuperDocDocument> {
  const { docPath, sessionId, collabUrl, collabDocumentId } = params;

  // 【获取SDK客户端】
  const sdkClient = await getClient();

  // 【构造打开文档的payload】
  const openPayload: DocOpenParams = { doc: docPath };

  // 【设置会话ID】
  if (sessionId) {
    openPayload.sessionId = sessionId;
  }

  // 【协作模式】
  // 如果提供了协作参数，则以协作模式打开
  // collabUrl + collabDocumentId是y-websocket协议的缩略参数写法
  // SDK内部会自动处理y-websocket连接和Yjs同步
  if (collabUrl) {
    openPayload.collabUrl = collabUrl;
    if (collabDocumentId) openPayload.collabDocumentId = collabDocumentId;
  }

  // 【打开文档】
  const doc = await sdkClient.open(openPayload);
  console.log(
    `[SDK] Document opened: ${docPath} room=${collabDocumentId ?? "none"}`,
  );
  return doc;
}

/**
 * 【文档类型】
 *
 * 【功能说明】
 * 从openDocument函数的返回类型推导
 */
export type RoomDocument = Awaited<ReturnType<typeof openDocument>>;

/**
 * 【会话结果类型】
 *
 * 【功能说明】
 * 会话操作的结果类型
 * 包含会话ID和文档句柄
 */
export type RoomSessionResult = {
  sessionId: string;
  doc: RoomDocument;
};

/**
 * 【关闭文档】
 *
 * 【功能说明】
 * 关闭文档句柄，释放SDK资源
 *
 * @param doc - 文档句柄
 * @param reason - 关闭原因
 */
async function closeDocument(
  doc: RoomDocument | null,
  reason = "unspecified",
): Promise<void> {
  if (doc) {
    await doc.close();
    console.log(`[SDK] Document closed reason=${reason}`);
  }
}

// ================================================================
// 【导出】
// ================================================================

/**
 * 【导出函数】
 *
 * 【功能说明】
 * 导出客户端管理和文档操作的函数
 * 供sessionManager等模块使用
 */
export { disposeClient, openDocument, closeDocument };
