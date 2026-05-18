import {
  closeDocument,
  disposeClient,
  DOCS_DIR,
  openDocument,
  type RoomDocument,
  type RoomSessionResult,
} from "../cliRunner";
import config from "../../config";
import { getDocumentById } from "../docServices";

type SessionEntry = {
  sessionId: string;
  doc: RoomDocument;
  docPath: string;
  roomName: string;
  createdAt: number;
  lastActivity: number;
};

const sessions = new Map<string, SessionEntry>();
const COLLAB_WS_URL = config.COLLAB_WS_URL;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function resolveRoomName(docId: string, metadata: any): string {
  return metadata?.roomName || docId;
}

function startSessionCleanup(): void {
  if (cleanupTimer) {
    return;
  }

  cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [docId, session] of sessions) {
      if (now - session.lastActivity <= SESSION_IDLE_TIMEOUT_MS) {
        continue;
      }

      console.log(
        `[SessionManager] Closing idle session: ${session.sessionId}`,
      );
      void closeDocument(session.doc);
      sessions.delete(docId);
    }
  }, 60 * 1000);
}

startSessionCleanup();

export async function createOrUseSession(
  docId: string,
): Promise<RoomSessionResult> {
  const metadata = await getDocumentById(docId);
  if (!metadata) {
    throw new Error(`文档不存在: ${docId}`);
  }

  const existing = sessions.get(docId);
  if (existing) {
    existing.lastActivity = Date.now();
    console.log(
      `[SessionManager] Reusing session: ${existing.sessionId} for ${docId}`,
    );
    return { sessionId: existing.sessionId, doc: existing.doc };
  }

  const roomName = resolveRoomName(docId, metadata);
  const fileName =
    metadata.filePath?.replace("/uploads/", "") || metadata.storedName;
  const docPath = fileName.startsWith("/")
    ? fileName
    : `${DOCS_DIR}/${fileName}`;
  const sessionId = `session-${roomName}-${Date.now()}`;

  console.log(
    `[SessionManager] Opening room session: ${sessionId} for ${docId}, room=${roomName}`,
  );

  try {
    const doc = await openDocument({
      docPath,
      sessionId,
      collabUrl: COLLAB_WS_URL,
      collabDocumentId: roomName,
    });

    sessions.set(docId, {
      sessionId,
      doc,
      docPath,
      roomName,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    return { sessionId, doc };
  } catch (error: any) {
    const isTimeout =
      error?.code === "COLLABORATION_SYNC_TIMEOUT" ||
      error?.code === "HOST_WATCHDOG_TIMEOUT" ||
      (typeof error?.message === "string" &&
        (error.message.includes("sync timed out") ||
          error.message.includes("watchdog timed") ||
          error.message.includes("request timed out")));

    if (isTimeout) {
      console.warn(
        `[SessionManager] Collaboration open timed out, disposing client: ${error.message}`,
      );
      await disposeClient();
    }

    throw error;
  }
}

export async function ensureYjsRoom(
  docId: string,
): Promise<{ docId: string; roomName: string; wsUrl: string }> {
  const metadata = await getDocumentById(docId);
  if (!metadata) {
    throw new Error(`文档不存在: ${docId}`);
  }

  return {
    docId,
    roomName: resolveRoomName(docId, metadata),
    wsUrl: COLLAB_WS_URL,
  };
}

export async function closeSessionByDocId(docId: string): Promise<void> {
  const session = sessions.get(docId);
  if (!session) {
    console.log(`[SessionManager] No session found for ${docId}`);
    return;
  }

  console.log(
    `[SessionManager] Closing session: ${session.sessionId} for ${docId}`,
  );
  await closeDocument(session.doc);
  sessions.delete(docId);
}

export async function closeAllSessions(): Promise<void> {
  console.log(`[SessionManager] Closing all sessions: ${sessions.size}`);

  for (const docId of Array.from(sessions.keys())) {
    await closeSessionByDocId(docId);
  }

  await disposeClient();
}
