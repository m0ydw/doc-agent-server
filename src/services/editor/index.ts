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
export const getStructure = formatOperations.getStructure;
export const findCell = formatOperations.findCell;
export const readTable = formatOperations.readTable;

export default {
  findText,
  replaceFirst,
  replaceAll,
  getText,
  getInfo,
  setText,
  applyFormat,
  getStructure,
  findCell,
  readTable,
};
