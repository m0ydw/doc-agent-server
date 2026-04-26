/**
 * Editor 模块统一入口
 */

// 编辑操作
import * as editorOperations from "./editorOperations";
import * as formatOperations from "./formatOperations";

// 导出所有操作
export const findText = editorOperations.findText;
export const replaceFirst = editorOperations.replaceFirst;
export const replaceAll = editorOperations.replaceAll;
export const getText = editorOperations.getTextContent;
export const getInfo = editorOperations.getDocumentInfo;
export const insertText = editorOperations.insertText;
export const deleteText = editorOperations.deleteText;

// 格式操作
export const setBold = formatOperations.setBold;
export const setItalic = formatOperations.setItalic;
export const setColor = formatOperations.setColor;
export const setFontSize = formatOperations.setFontSize;
export const setUnderline = formatOperations.setUnderline;
export const setFontFamily = formatOperations.setFontFamily;

export default {
  findText,
  replaceFirst,
  replaceAll,
  getText,
  getInfo,
  insertText,
  deleteText,
  setBold,
  setItalic,
  setColor,
  setFontSize,
  setUnderline,
  setFontFamily,
};