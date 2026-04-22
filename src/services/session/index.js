const sessionManager = require("./sessionManager");

module.exports = {
  createOrUseSession: sessionManager.createOrUseSession,
  closeSessionByDocId: sessionManager.closeSessionByDocId,
  saveDocumentById: sessionManager.saveDocumentById,
  closeAllSessions: sessionManager.closeAllSessions,
  getSession: sessionManager.getSession,
  hasSession: sessionManager.hasSession,
  getActiveSessionDocIds: sessionManager.getActiveSessionDocIds,
  ensureYjsRoom: sessionManager.ensureYjsRoom,
  getRoomInfoByDocId: sessionManager.getRoomInfoByDocId,
  getOrCreateRoomYDoc: sessionManager.getOrCreateRoomYDoc,
  getRoomByDocId: sessionManager.getRoomByDocId,
  removeRoomByDocId: sessionManager.removeRoomByDocId,
};
