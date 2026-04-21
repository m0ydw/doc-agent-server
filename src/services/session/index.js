const sessionManager = require("./sessionManager");

module.exports = {
  createOrUseSession: sessionManager.createOrUseSession,
  saveDocumentById: sessionManager.saveDocumentById,
  closeAllSessions: sessionManager.closeAllSessions,
  getSession: sessionManager.getSession,
  hasSession: sessionManager.hasSession,
  getActiveSessionDocIds: sessionManager.getActiveSessionDocIds,
  ensureYjsRoom: sessionManager.ensureYjsRoom,
};
