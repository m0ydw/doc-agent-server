import * as sessionManager from "./sessionManager";

export const createOrUseSession = sessionManager.createOrUseSession;
export const closeSessionByDocId = sessionManager.closeSessionByDocId;
export const saveDocumentById = sessionManager.saveDocumentById;
export const closeAllSessions = sessionManager.closeAllSessions;
export const getSession = sessionManager.getSession;
export const hasSession = sessionManager.hasSession;
export const getActiveSessionDocIds = sessionManager.getActiveSessionDocIds;
export const ensureYjsRoom = sessionManager.ensureYjsRoom;
export const getRoomInfoByDocId = sessionManager.getRoomInfoByDocId;
export const getOrCreateRoomYDoc = sessionManager.getOrCreateRoomYDoc;
export const getRoomByDocId = sessionManager.getRoomByDocId;
export const getRoomByName = sessionManager.getRoomByName;
export const registerRoom = sessionManager.registerRoom;
export const removeRoomByDocId = sessionManager.removeRoomByDocId;