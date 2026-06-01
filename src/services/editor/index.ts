/**
 * ============================================================
 * 【编辑器模块统一入口 - editor/index.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是编辑器模块的入口文件，负责：
 * 1. 统一导出所有编辑操作函数
 * 2. 统一导出所有格式操作函数
 * 3. 作为编辑器模块的统一出口
 * 
 * 【架构位置】
 * docOperationsRoutes.ts → import * as editor from "../services/editor"
 *   ↓
 * 【editor/index.ts】 → 导出所有编辑和格式操作函数
 *   ↓
 * editorOperations.ts → 编辑操作实现
 * formatOperations.ts → 格式操作实现
 * 
 * 【数据流】
 * 路由调用editor.findText()
 *   ↓
 * index.ts重导出到editorOperations.findText()
 *   ↓
 * editorOperations.ts执行实际的查找操作
 * 
 * 【导出的函数分类】
 * 
 * 1. 编辑操作（editorOperations）：
 *    - findText: 查找文本
 *    - replaceFirst: 替换第一个匹配
 *    - replaceAll: 替换所有匹配
 *    - replaceByRefs: 根据引用替换
 *    - getText: 获取纯文本
 *    - getInfo: 获取文档信息
 * 
 * 2. 格式操作（formatOperations）：
 *    - setText: 设置文本
 *    - applyFormat: 应用格式
 *    - inspectDocumentStructure: 获取文档结构
 *    - readTableContent: 读取表格内容
 *    - readTableCellText: 读取单元格文本
 *    - readTableStyle: 读取表格样式
 *    - applyTableFormat: 应用表格格式
 *    - inspectTextBlocks: 检查文本块
 *    - readTextBlock: 读取文本块
 *    - insertTextAtBlockOffset: 在指定位置插入文本
 *    - findTextTargets: 查找文本目标
 *    - readTextStyle: 读取文本样式
 *    - applyTextStyle: 应用文本样式
 *    - extractApplicableTextStyle: 提取可应用的文本样式
 *    - writeCellsText: 批量写入单元格
 *    - verifyCells: 验证单元格
 * 
 * 【使用方式】
 * import * as editor from "../services/editor";
 * 
 * // 查找文本
 * const result = await editor.findText(docId, pattern);
 * 
 * // 替换文本
 * await editor.replaceFirst(docId, targetText, replacement);
 * 
 * // 获取纯文本
 * const text = await editor.getText(docId);
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【编辑操作模块】
// 导入所有编辑操作函数
import * as editorOperations from "./editorOperations";

// 【格式操作模块】
// 导入所有格式操作函数
import * as formatOperations from "./formatOperations";

// ================================================================
// 【编辑操作导出】
// ================================================================

/**
 * 【查找文本】
 * 
 * 【功能说明】
 * 在文档中搜索指定文本的所有匹配
 * 
 * @see editorOperations.findText
 */
export const findText = editorOperations.findText;

/**
 * 【替换第一个匹配】
 * 
 * 【功能说明】
 * 替换文档中第一个匹配的文本
 * 
 * @see editorOperations.replaceFirst
 */
export const replaceFirst = editorOperations.replaceFirst;

/**
 * 【替换所有匹配】
 * 
 * 【功能说明】
 * 替换文档中所有匹配的文本
 * 
 * @see editorOperations.replaceAll
 */
export const replaceAll = editorOperations.replaceAll;

/**
 * 【根据引用替换】
 * 
 * 【功能说明】
 * 根据ref引用批量替换文本
 * 
 * @see editorOperations.replaceByRefs
 */
export const replaceByRefs = editorOperations.replaceByRefs;

/**
 * 【获取纯文本】
 * 
 * 【功能说明】
 * 获取文档的完整纯文本内容
 * 
 * @see editorOperations.getTextContent
 */
export const getText = editorOperations.getTextContent;

/**
 * 【获取文档信息】
 * 
 * 【功能说明】
 * 获取文档的结构化信息
 * 
 * @see editorOperations.getDocumentInfo
 */
export const getInfo = editorOperations.getDocumentInfo;

// ================================================================
// 【格式操作导出】
// ================================================================

/**
 * 【设置文本】
 * 
 * 【功能说明】
 * 在文档指定ref位置写入文本
 * 
 * @see formatOperations.setText
 */
export const setText = formatOperations.setText;

/**
 * 【应用格式】
 * 
 * 【功能说明】
 * 查找匹配文本并应用格式
 * 
 * @see formatOperations.applyFormat
 */
export const applyFormat = formatOperations.applyFormat;

/**
 * 【获取文档结构】
 * 
 * 【功能说明】
 * 获取文档中所有表格的大致内容
 * 
 * @see formatOperations.inspectDocumentStructure
 */
export const inspectDocumentStructure = formatOperations.inspectDocumentStructure;

/**
 * 【读取表格内容】
 * 
 * 【功能说明】
 * 读取指定表格的完整数据
 * 
 * @see formatOperations.readTableContent
 */
export const readTableContent = formatOperations.readTableContent;

/**
 * 【读取单元格文本】
 * 
 * 【功能说明】
 * 读取指定单元格的文本内容
 * 
 * @see formatOperations.readTableCellText
 */
export const readTableCellText = formatOperations.readTableCellText;

/**
 * 【读取表格样式】
 * 
 * 【功能说明】
 * 读取表格的样式信息
 * 
 * @see formatOperations.readTableStyle
 */
export const readTableStyle = formatOperations.readTableStyle;

/**
 * 【应用表格格式】
 * 
 * 【功能说明】
 * 应用表格的格式
 * 
 * @see formatOperations.applyTableFormat
 */
export const applyTableFormat = formatOperations.applyTableFormat;

/**
 * 【检查文本块】
 * 
 * 【功能说明】
 * 检查文档中的文本块
 * 
 * @see formatOperations.inspectTextBlocks
 */
export const inspectTextBlocks = formatOperations.inspectTextBlocks;

/**
 * 【读取文本块】
 * 
 * 【功能说明】
 * 读取指定的文本块
 * 
 * @see formatOperations.readTextBlock
 */
export const readTextBlock = formatOperations.readTextBlock;

/**
 * 【在指定位置插入文本】
 * 
 * 【功能说明】
 * 在文本块的指定偏移位置插入文本
 * 
 * @see formatOperations.insertTextAtBlockOffset
 */
export const insertTextAtBlockOffset = formatOperations.insertTextAtBlockOffset;

/**
 * 【查找文本目标】
 * 
 * 【功能说明】
 * 查找文本目标
 * 
 * @see formatOperations.findTextTargets
 */
export const findTextTargets = formatOperations.findTextTargets;

/**
 * 【读取文本样式】
 * 
 * 【功能说明】
 * 读取文本的样式信息
 * 
 * @see formatOperations.readTextStyle
 */
export const readTextStyle = formatOperations.readTextStyle;

/**
 * 【应用文本样式】
 * 
 * 【功能说明】
 * 应用文本的样式
 * 
 * @see formatOperations.applyTextStyle
 */
export const applyTextStyle = formatOperations.applyTextStyle;

/**
 * 【提取可应用的文本样式】
 * 
 * 【功能说明】
 * 提取可应用的文本样式
 * 
 * @see formatOperations.extractApplicableTextStyle
 */
export const extractApplicableTextStyle =
  formatOperations.extractApplicableTextStyle;

/**
 * 【批量写入单元格】
 * 
 * 【功能说明】
 * 将多个单元格的文本内容批量写入文档
 * 每个单元格独立处理，互不影响
 * 
 * @see formatOperations.writeCellsText
 */
export const writeCellsText = formatOperations.writeCellsText;

/**
 * 【验证单元格】
 * 
 * 【功能说明】
 * 检查指定单元格的当前文本是否等于期望值
 * 用于写入后的验证，确保写入操作真正生效
 * 
 * @see formatOperations.verifyCells
 */
export const verifyCells = formatOperations.verifyCells;

// ================================================================
// 【默认导出】
// ================================================================

/**
 * 【默认导出】
 * 
 * 【功能说明】
 * 将所有函数作为默认导出的对象
 * 支持两种导入方式：
 * 1. 命名导入：import { findText } from "../services/editor"
 * 2. 默认导入：import editor from "../services/editor"; editor.findText()
 */
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
  readTableStyle,
  applyTableFormat,
  inspectTextBlocks,
  readTextBlock,
  insertTextAtBlockOffset,
  findTextTargets,
  readTextStyle,
  applyTextStyle,
  writeCellsText,
  verifyCells,
};
