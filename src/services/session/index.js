const sessionManager = require("./sessionManager");

module.exports = {
  createOrUseSession: sessionManager.createOrUseSession,
  closeSession: sessionManager.closeSessionByDocId,
  closeAllSessions: sessionManager.closeAllSessions,
  getSession: sessionManager.getSession,
  hasSession: sessionManager.hasSession,
  getActiveSessionDocIds: sessionManager.getActiveSessionDocIds,
};
