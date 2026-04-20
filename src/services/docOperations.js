/**
 * @deprecated 使用 services/editor 替代
 * 保留此文件用于向后兼容，新代码请使用 services/editor
 */

const editor = require("./editor");

module.exports = {
  // 查找
  findTextPositions: editor.findText,
  findAllOccurrences: editor.findText, // 兼容旧名称

  // 替换
  replaceFirstOccurrence: editor.replaceFirst,
  replaceAllOccurrences: editor.replaceAll,

  // 文档信息
  getDocumentText: editor.getText,
  getDocumentInfo: editor.getInfo,
};