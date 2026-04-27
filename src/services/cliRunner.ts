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
  const { docPath, sessionId, collabUrl, collabDocumentId, onMissing, bootstrapSettlingMs } = params;
  const sdkClient = await getClient();

  const openPayload: any = { doc: docPath };

  if (sessionId) {
    openPayload.sessionId = sessionId;
  }

  if (collabUrl) {
    openPayload.collabUrl = collabUrl;
    if (collabDocumentId) openPayload.collabDocumentId = collabDocumentId;
    if (onMissing) openPayload.onMissing = onMissing;
    if (bootstrapSettlingMs) openPayload.bootstrapSettlingMs = bootstrapSettlingMs;
  }

  const doc = await sdkClient.open(openPayload);
  console.log(`[SDK] Document opened: ${docPath} room=${collabDocumentId ?? 'none'}`);
  return doc;
}

async function closeDocument(doc: Document | null): Promise<void> {
  if (doc) {
    await doc.close();
    console.log("[SDK] Document closed");
  }
}

export {
  disposeClient,
  openDocument,
  closeDocument,
  DOCS_DIR,
};
