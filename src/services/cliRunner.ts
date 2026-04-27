import path from "path";

// 文档目录
const DOCS_DIR = path.join(__dirname, "../../uploads");

// SDK 客户端（单例）
let client: any = null;
let isConnected = false;

async function getClient(): Promise<any> {
  if (client && isConnected) {
    return client;
  }

  const superdoc = await import("@superdoc-dev/sdk");
  const createSuperDocClient = superdoc.createSuperDocClient;

  client = createSuperDocClient({
    env: {
      SUPERDOC_DEBUG_TEXT_REWRITE: "1",
    },
    user: { name: "Agent", email: "agent@local" },
    // Hocuspocus 协议握手 + 同步可能耗时，调大超时避免 SDK 提前截杀
    requestTimeoutMs: 90000,
    watchdogTimeoutMs: 90000,
  });
  await client.connect();
  isConnected = true;

  console.log("[SDK] Client connected (timeout=90s)");
  return client;
}

async function disposeClient(): Promise<void> {
  if (client) {
    await client.dispose();
    client = null;
    isConnected = false;
    console.log("[SDK] Client disposed");
  }
}

export interface OpenParams {
  docPath: string;
  sessionId?: string;
  collaboration?: {
    providerType?: string;
    url?: string;
    documentId?: string;
    onMissing?: string;
    syncTimeoutMs?: number;
    bootstrapSettlingMs?: number;
  };
  // 缩略参数（避免 CLI --collaboration-json JSON 解析导致进程挂死）
  collabUrl?: string;
  collabDocumentId?: string;
  onMissing?: string;
  bootstrapSettlingMs?: number;
}

export interface Document {
  close: () => Promise<void>;
  save: (options: any) => Promise<void>;
  getText: () => Promise<string>;
  info: () => Promise<any>;
  query: {
    match: (params: any) => Promise<any>;
  };
  mutations: {
    apply: (params: any) => Promise<any>;
  };
}

async function openDocument(params: OpenParams): Promise<Document> {
  const { docPath, sessionId, collaboration, collabUrl, collabDocumentId, onMissing, bootstrapSettlingMs } = params;
  const sdkClient = await getClient();

  const openPayload: any = { doc: docPath };

  if (sessionId) {
    openPayload.sessionId = sessionId;
  }

  // 缩略参数优先（简单 CLI flag，避免 --collaboration-json JSON 解析 bug）
  if (collabUrl) {
    openPayload.collabUrl = collabUrl;
    if (collabDocumentId) openPayload.collabDocumentId = collabDocumentId;
    if (onMissing) openPayload.onMissing = onMissing;
    if (bootstrapSettlingMs) openPayload.bootstrapSettlingMs = bootstrapSettlingMs;
  } else if (collaboration) {
    openPayload.collaboration = collaboration;
  }

  const doc = await sdkClient.open(openPayload);
  const roomId = collabUrl ? (collabDocumentId ?? 'none') : (collaboration?.documentId ?? 'none');
  console.log(`[SDK] Document opened: ${docPath} room=${roomId}`);
  return doc;
}

async function closeDocument(doc: Document | null): Promise<void> {
  if (doc) {
    await doc.close();
    console.log("[SDK] Document closed");
  }
}

async function saveDocument(doc: Document | null, options = { inPlace: true }): Promise<void> {
  if (doc) {
    await doc.save(options);
    console.log("[SDK] Document saved");
  }
}

async function getTextContent(doc: Document): Promise<string> {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.getText();
}

async function getInfo(doc: Document): Promise<any> {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.info();
}

async function queryMatch(doc: Document, params: any): Promise<any> {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.query.match(params);
}

async function applyMutations(doc: Document, params: any): Promise<any> {
  if (!doc) {
    throw new Error("Document not opened");
  }
  return await doc.mutations.apply(params);
}

async function openWithSession(docPath: string, sessionId: string): Promise<Document> {
  return await openDocument({ docPath, sessionId });
}

async function closeSession(_sessionId: string): Promise<{ success: boolean }> {
  return { success: true };
}

async function saveSession(_sessionId: string): Promise<{ success: boolean }> {
  return { success: true };
}

async function runQuery(_args: string[]): Promise<any> {
  throw new Error("runQuery is deprecated, use SDK directly");
}

async function runCommand(_args: string[]): Promise<string> {
  throw new Error("runCommand is deprecated, use SDK directly");
}

export {
  getClient,
  disposeClient,
  openDocument,
  closeDocument,
  saveDocument,
  getTextContent,
  getInfo,
  queryMatch,
  applyMutations,
  openWithSession,
  closeSession,
  saveSession,
  runQuery,
  runCommand,
};

export { DOCS_DIR };