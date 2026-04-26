import path from "path";
import Y from "yjs";
import {
  disposeClient,
  openDocument,
  closeDocument,
  saveDocument,
  Document,
} from "../cliRunner";
import { getDocumentById, DocumentMetadata } from "../docServices";
import config from "../../config";

const sessions = new Map<string, any>();
const rooms = new Map<string, any>();
const HOCUSPOCUS_URL = config.HOCUSPOCUS_URL;

function resolveRoomName(docId: string, metadata: any) {
  return metadata?.roomName || docId;
}

function touchRoom(room: any, docId?: string) {
  if (docId && !room.docId) {
    room.docId = docId;
  }
  room.lastActiveAt = Date.now();
  return room;
}

export interface Room {
  roomName: string;
  docId: string | null;
  ydoc: Y.Doc;
  createdAt: number;
  lastActiveAt: number;
}

function ensureRoom(roomName: string, docId?: string, _metadata?: any): Room {
  const existing = rooms.get(roomName);
  if (existing) return touchRoom(existing, docId);
  const ydoc = new Y.Doc();
  const room: Room = { roomName, docId: docId || null, ydoc, createdAt: Date.now(), lastActiveAt: Date.now() };
  rooms.set(roomName, room);
  return room;
}

export function getRoomByDocId(docId: string): Room | null {
  const metadata = getDocumentById(docId);
  const roomName = resolveRoomName(docId, metadata);
  return rooms.get(roomName) || null;
}

export function getRoomByName(roomName: string): Room | null {
  return rooms.get(roomName);
}

export function registerRoom(roomName: string, ydoc: Y.Doc, docId?: string): Room {
  const existing = rooms.get(roomName);
  if (existing) return existing;
  const room: Room = { roomName, docId: docId || null, ydoc, createdAt: Date.now(), lastActiveAt: Date.now() };
  rooms.set(roomName, room);
  return room;
}

export function getOrCreateRoomYDoc(roomName: string, _docId?: string): Y.Doc | null {
  const existingRoom = rooms.get(roomName);
  if (existingRoom) return existingRoom.ydoc;
  return null;
}

function removeRoomByName(roomName: string): void {
  const room = rooms.get(roomName);
  if (!room) return;
  if (room.ydoc && typeof room.ydoc.destroy === "function") room.ydoc.destroy();
  rooms.delete(roomName);
}

export function removeRoomByDocId(docId: string): void {
  const session = sessions.get(docId);
  const metadata = getDocumentById(docId);
  const roomName = session?.roomName || resolveRoomName(docId, metadata);
  if (roomName) removeRoomByName(roomName);
}

export async function createOrUseSession(docId: string): Promise<{ sessionId: string; doc: Document }> {
  const metadata = getDocumentById(docId);
  if (!metadata) throw new Error(`文档不存在: ${docId}`);
  const roomName = resolveRoomName(docId, metadata);
  ensureRoom(roomName, docId, metadata);
  if (sessions.has(docId)) {
    const session = sessions.get(docId);
    console.log(`[SessionManager] 使用已有会话: ${session.sessionId} for ${docId}`);
    return { sessionId: session.sessionId, doc: session.doc };
  }
  const { DOCS_DIR } = await import("../cliRunner");
  const docPath = path.join(DOCS_DIR as string, metadata.storedName);
  const sessionId = `session-${roomName}-${Date.now()}`;
  console.log(`[SessionManager] 创建协作会话: ${sessionId} for ${docId}, room=${roomName}`);
  const doc = await openDocument({
    docPath,
    sessionId,
    collaboration: { providerType: "hocuspocus", url: HOCUSPOCUS_URL, documentId: roomName, onMissing: "seedFromDoc" },
  });
  sessions.set(docId, { sessionId, doc, docPath, roomName, createdAt: Date.now() });
  return { sessionId, doc };
}

export function getSessionDoc(docId: string): Document | null {
  const session = sessions.get(docId);
  return session ? session.doc : null;
}

export async function closeSessionByDocId(docId: string): Promise<void> {
  const session = sessions.get(docId);
  if (!session) { console.log(`[SessionManager] 会话不存在: ${docId}`); return; }
  console.log(`[SessionManager] 关闭会话: ${session.sessionId} for ${docId}`);
  try { await closeDocument(session.doc); } catch (e) { console.error(`[SessionManager] 关闭失败: ${e.message}`); }
  sessions.delete(docId);
}

export async function saveDocumentById(docId: string): Promise<void> {
  let session = sessions.get(docId);
  if (!session) { await createOrUseSession(docId); session = sessions.get(docId); }
  if (!session) throw new Error("会话不存在");
  console.log(`[SessionManager] 保存文档: ${session.sessionId} for ${docId}`);
  await saveDocument(session.doc, { inPlace: true });
  console.log(`[SessionManager] 文档已保存，Yjs 同步触发`);
}

export async function closeAllSessions(): Promise<void> {
  console.log(`[SessionManager] 关闭所有会话，当前活跃: ${sessions.size}`);
  const docIds = Array.from(sessions.keys());
  for (const docId of docIds) await closeSessionByDocId(docId);
  await disposeClient();
  const roomNames = Array.from(rooms.keys());
  roomNames.forEach((rn) => removeRoomByName(rn));
  console.log(`[SessionManager] 所有会话已关闭`);
}

export function getSession(docId: string): any {
  const session = sessions.get(docId);
  if (!session) return null;
  return { sessionId: session.sessionId, doc: session.doc, docPath: session.docPath, roomName: session.roomName };
}

export function hasSession(docId: string): boolean {
  return sessions.has(docId);
}

export async function ensureYjsRoom(docId: string): Promise<{ docId: string; roomName: string; wsUrl: string }> {
  const metadata = getDocumentById(docId);
  if (!metadata) throw new Error(`文档不存在: ${docId}`);
  const roomName = resolveRoomName(docId, metadata);
  return { docId, roomName, wsUrl: HOCUSPOCUS_URL };
}

export function getActiveSessionDocIds(): string[] {
  return Array.from(sessions.keys());
}

export function getRoomInfoByDocId(docId: string): any {
  const metadata = getDocumentById(docId);
  if (!metadata) return null;
  const roomName = resolveRoomName(docId, metadata);
  const room = ensureRoom(roomName, docId, metadata);
  return { docId, roomName, wsUrl: HOCUSPOCUS_URL, createdAt: room.createdAt, hasSession: sessions.has(docId) };
}