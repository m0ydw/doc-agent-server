const sessionManager = require("./sessionManager");

module.exports = {
  createOrUseSession: sessionManager.createOrUseSession,
  saveSession: sessionManager.saveSession,
  closeAllSessions: sessionManager.closeAllSessions,
  getSession: sessionManager.getSession,
  hasSession: sessionManager.hasSession,
  getActiveSessionDocIds: sessionManager.getActiveSessionDocIds,
};
