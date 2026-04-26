import * as sessionManager from "./sessionManager";

export const createOrUseSession = sessionManager.createOrUseSession;
export const closeSessionByDocId = sessionManager.closeSessionByDocId;
export const closeAllSessions = sessionManager.closeAllSessions;
export const getSession = sessionManager.getSession;
export const hasSession = sessionManager.hasSession;
export const getActiveSessionDocIds = sessionManager.getActiveSessionDocIds;
export const ensureYjsRoom = sessionManager.ensureYjsRoom;
export const getSessionDoc = sessionManager.getSessionDoc;