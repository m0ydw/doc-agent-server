/**
 * Editor 模块统一入口
 */

import * as editorOperations from "./editorOperations";
import * as formatOperations from "./formatOperations";

export const findText = editorOperations.findText;
export const replaceFirst = editorOperations.replaceFirst;
export const replaceAll = editorOperations.replaceAll;
export const getText = editorOperations.getTextContent;
export const getInfo = editorOperations.getDocumentInfo;
export const setText = formatOperations.setText;
export const applyFormat = formatOperations.applyFormat;
export const inspectDocumentStructure = formatOperations.inspectDocumentStructure;
export const readTableContent = formatOperations.readTableContent;
export const readTableCellText = formatOperations.readTableCellText;

export default {
  findText,
  replaceFirst,
  replaceAll,
  getText,
  getInfo,
  setText,
  applyFormat,
  inspectDocumentStructure,
  readTableContent,
  readTableCellText,
};
