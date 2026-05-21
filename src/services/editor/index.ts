/**
 * Editor 模块统一入口
 */

import * as editorOperations from "./editorOperations";
import * as formatOperations from "./formatOperations";

export const findText = editorOperations.findText;
export const replaceFirst = editorOperations.replaceFirst;
export const replaceAll = editorOperations.replaceAll;
export const replaceByRefs = editorOperations.replaceByRefs;
export const getText = editorOperations.getTextContent;
export const getInfo = editorOperations.getDocumentInfo;
export const setText = formatOperations.setText;
export const applyFormat = formatOperations.applyFormat;
export const inspectDocumentStructure = formatOperations.inspectDocumentStructure;
export const readTableContent = formatOperations.readTableContent;
export const readTableCellText = formatOperations.readTableCellText;
/**
 * 【新增】单元格批量写入函数
 * 
 * 将多个单元格的文本内容批量写入文档。
 * 每个单元格独立处理，互不影响。
 * 
 * @see formatOperations.writeCellsText - 详细实现
 */
export const writeCellsText = formatOperations.writeCellsText;

/**
 * 【新增】单元格验证函数
 * 
 * 检查指定单元格的当前文本是否等于期望值。
 * 用于写入后的验证，确保写入操作真正生效。
 * 
 * @see formatOperations.verifyCells - 详细实现
 */
export const verifyCells = formatOperations.verifyCells;

/**
 * 【新增】修订模式写入函数（预留接口）
 * 
 * 以修订模式写入单元格，保留修改痕迹。
 * 当前版本暂未实现，返回失败。
 * 
 * @see formatOperations.writeCellsTextTracked - 详细实现
 */
export const writeCellsTextTracked = formatOperations.writeCellsTextTracked;

export default {
  findText,
  replaceFirst,
  replaceAll,
  replaceByRefs,
  getText,
  getInfo,
  setText,
  applyFormat,
  inspectDocumentStructure,
  readTableContent,
  readTableCellText,
  writeCellsText,
  verifyCells,
  writeCellsTextTracked,
};
