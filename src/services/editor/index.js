/**
 * Editor 模块统一入口
 */

// 编辑操作
const editorOperations = require("./editorOperations");
const formatOperations = require("./formatOperations");

// 导出所有操作
module.exports = {
  // 编辑操作
  findText: editorOperations.findText,
  replaceFirst: editorOperations.replaceFirst,
  replaceAll: editorOperations.replaceAll,
  getText: editorOperations.getText,
  getInfo: editorOperations.getInfo,
  insertText: editorOperations.insertText,
  deleteText: editorOperations.deleteText,

  // 格式操作（预留）
  setBold: formatOperations.setBold,
  setItalic: formatOperations.setItalic,
  setColor: formatOperations.setColor,
  setFontSize: formatOperations.setFontSize,
  setUnderline: formatOperations.setUnderline,
  setFontFamily: formatOperations.setFontFamily,
};