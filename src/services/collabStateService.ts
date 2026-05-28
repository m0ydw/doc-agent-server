import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import type { CollaborationParams } from "@superdoc-dev/superdoc-yjs-collaboration";
import * as Y from "yjs";

import { UPLOAD_DIR } from "./docServices";

export const COLLAB_STATE_DIR = path.join(UPLOAD_DIR, ".collab-state");

function ensureStateDir(): void {
  if (!existsSync(COLLAB_STATE_DIR)) {
    mkdirSync(COLLAB_STATE_DIR, { recursive: true });
  }
}

function safeRoomName(roomName: string): string {
  return roomName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getStatePath(roomName: string): string {
  return path.join(COLLAB_STATE_DIR, `${safeRoomName(roomName)}.bin`);
}

export async function loadCollabState(
  roomName: string,
): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(getStatePath(roomName));
  } catch {
    return null;
  }
}

export async function saveCollabState(params: CollaborationParams): Promise<void> {
  if (!params.document) return;

  ensureStateDir();
  const statePath = getStatePath(params.documentId);
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const update = Y.encodeStateAsUpdate(params.document as unknown as Y.Doc);

  await fs.writeFile(tempPath, update);
  await fs.rename(tempPath, statePath);
}

export async function deleteCollabState(roomName: string): Promise<void> {
  try {
    await fs.unlink(getStatePath(roomName));
  } catch {
    // Missing state is expected for documents that were never edited collaboratively.
  }
}

export async function cleanupCollabStates(keepRoomNames: string[]): Promise<void> {
  ensureStateDir();
  const keep = new Set(keepRoomNames.map((roomName) => `${safeRoomName(roomName)}.bin`));
  const files = await fs.readdir(COLLAB_STATE_DIR);

  await Promise.all(
    files
      .filter((file) => file.endsWith(".bin") && !keep.has(file))
      .map((file) => fs.unlink(path.join(COLLAB_STATE_DIR, file)).catch(() => {})),
  );
}

export async function hasCollabState(roomName: string): Promise<boolean> {
  try {
    await fs.access(getStatePath(roomName));
    return true;
  } catch {
    return false;
  }
}
