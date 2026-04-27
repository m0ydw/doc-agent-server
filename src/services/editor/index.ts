/**
 * Editor 模块统一入口
 */

import * as editorOperations from "./editorOperations";

export const findText = editorOperations.findText;
export const replaceFirst = editorOperations.replaceFirst;
export const replaceAll = editorOperations.replaceAll;
export const getText = editorOperations.getTextContent;
export const getInfo = editorOperations.getDocumentInfo;

export default {
  findText,
  replaceFirst,
  replaceAll,
  getText,
  getInfo,
};
