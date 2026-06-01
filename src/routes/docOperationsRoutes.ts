/**
 * ============================================================
 * 【文档操作路由 - docOperationsRoutes.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是文档操作的路由文件，负责：
 * 1. 文本查找（find）
 * 2. 文本替换（replace）
 * 3. 纯文本获取（text）
 * 4. 文档信息获取（info）
 * 5. 文本设置（set-text）
 * 6. 格式应用（apply-format）
 * 7. 文档结构概览（inspect-document-structure）
 * 8. 表格内容读取（read-table-content）
 * 9. 表格单元格文本读取（read-table-cell-text）
 * 
 * 【架构位置】
 * 前端/AI Agent → 【docOperationsRoutes】 → editor → sessionManager → cliRunner → SDK
 * 
 * 【数据流】
 * 前端发送POST /api/doc-operations/find
 *   ↓
 * 路由处理请求
 *   ↓
 * 调用editor.findText()
 *   ↓
 * 返回查找结果
 * 
 * 【使用的模块】
 * express: Web应用框架
 *   - Router: 路由路由器
 *   - Request: 请求对象
 *   - Response: 响应对象
 * 
 * editor: 编辑操作模块
 *   - findText: 查找文本
 *   - replaceFirst: 替换第一个匹配
 *   - replaceAll: 替换所有匹配
 *   - getText: 获取纯文本
 *   - getInfo: 获取文档信息
 *   - setText: 设置文本
 *   - applyFormat: 应用格式
 *   - inspectDocumentStructure: 获取文档结构概览
 *   - readTableContent: 读取表格内容
 *   - readTableCellText: 读取表格单元格文本
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【Express框架】
// 导入Express及其类型定义
import express, { Request, Response, Router } from "express";

// 【编辑操作模块】
// 文档的编辑操作
import * as editor from "../services/editor";

// ================================================================
// 【路由初始化】
// ================================================================

/**
 * 【创建路由实例】
 * 
 * 【功能说明】
 * 创建Express路由实例
 * 所有文档操作的API端点都挂载到这个路由上
 */
const router: Router = express.Router();

// ================================================================
// 【API端点】
// ================================================================

/**
 * 【查找文本】
 * 
 * 【功能说明】
 * 在文档中搜索指定pattern的所有匹配位置
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/doc-operations/find
 * 请求体: { docId, pattern }
 * 
 * 【响应格式】
 * { success, pattern, count, positions[] }
 * positions中每个元素包含index、text、ref（SDK引用标识）等信息
 * 
 * 【执行流程】
 * 1. 验证参数
 * 2. 调用editor.findText()
 * 3. 返回查找结果
 */
router.post("/find", async (req: Request, res: Response) => {
  try {
    const { docId, pattern } = req.body;
    
    // 【验证参数】
    if (!docId || !pattern) {
      return res.status(400).json({ error: "缺少 docId 或 pattern" });
    }

    // 【调用editor层查找】
    const positions = await editor.findText(docId, pattern);
    
    res.json({
      success: true,
      pattern,
      count: positions.length,
      positions,
    });
  } catch (error) {
    console.error("查找失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 【替换文本】
 * 
 * 【功能说明】
 * 在文档中将targetText替换为replacement
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/doc-operations/replace
 * 请求体: { docId, targetText, replacement, replaceAll? }
 * 
 * 【替换策略】
 * - replaceAll=false: 只替换第一个匹配项
 * - replaceAll=true: 替换全部匹配项
 * 
 * 【响应格式】
 * { success, replaced (替换的数量) }
 * 
 * 【执行流程】
 * 1. 验证参数
 * 2. 根据replaceAll参数选择替换策略
 * 3. 调用editor.replaceFirst()或editor.replaceAll()
 * 4. 返回替换结果
 */
router.post("/replace", async (req: Request, res: Response) => {
  try {
    const { docId, targetText, replacement, replaceAll = false } = req.body;
    
    // 【验证参数】
    if (!docId || !targetText || !replacement) {
      return res.status(400).json({ error: "缺少必要参数" });
    }

    // 【根据replaceAll参数选择替换策略】
    const result = replaceAll
      ? await editor.replaceAll(docId, targetText, replacement)
      : await editor.replaceFirst(docId, targetText, replacement);

    res.json(result);
  } catch (error) {
    console.error("替换失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 【获取文档纯文本】
 * 
 * 【功能说明】
 * 返回文档的完整文本内容（不含格式）
 * 主要用于AI分析、全文搜索等需要纯文本的场景
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/doc-operations/text/:id
 * 
 * 【响应格式】
 * { success, text }
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 调用editor.getText()
 * 3. 返回纯文本
 */
router.get("/text/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    
    // 【获取纯文本】
    const text = await editor.getText(id);
    
    res.json({
      success: true,
      text,
    });
  } catch (error) {
    console.error("获取文本失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 【获取文档信息】
 * 
 * 【功能说明】
 * 返回文档的结构化信息（如页数、段落数、表格数等元数据）
 * 供AI Agent在分析阶段快速了解文档结构
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/doc-operations/info/:id
 * 
 * 【响应格式】
 * { success, info }
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 调用editor.getInfo()
 * 3. 返回文档信息
 */
router.get("/info/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    
    // 【获取文档信息】
    const info = await editor.getInfo(id);
    
    res.json({
      success: true,
      info,
    });
  } catch (error) {
    console.error("获取信息失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// ================================================================
// 【SDK操作路由】
// ================================================================

/**
 * 【设置文本】
 * 
 * 【功能说明】
 * 在文档指定ref位置写入文本
 * ref来自findText返回的positions[].ref，用于精确定位
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/doc-operations/set-text
 * 请求体: { docId, ref, text }
 * 
 * 【响应格式】
 * { success, message }
 * 
 * 【执行流程】
 * 1. 验证参数
 * 2. 调用editor.setText()
 * 3. 返回设置结果
 */
router.post("/set-text", async (req: Request, res: Response) => {
  try {
    const { docId, ref, text } = req.body;
    
    // 【验证参数】
    if (!docId || !ref || text === undefined) {
      return res.status(400).json({ error: "缺少 docId、ref 或 text" });
    }
    
    // 【设置文本】
    const result = await editor.setText(docId, ref, text);
    
    res.json({ success: true, message: result });
  } catch (error) {
    console.error("设置文本失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 【应用格式】
 * 
 * 【功能说明】
 * 查找匹配文本并应用格式（加粗/斜体/下划线/删除线）
 * 
 * 【HTTP请求】
 * 方法: POST
 * 端点: /api/doc-operations/apply-format
 * 请求体: { docId, pattern, format: { bold?, italic?, underline?, strike? } }
 * 
 * 【格式选项】
 * format的每个属性值为"on"或"off"
 * 
 * 【响应格式】
 * { success, message }
 * 
 * 【执行流程】
 * 1. 验证参数
 * 2. 调用editor.applyFormat()
 * 3. 返回应用结果
 */
router.post("/apply-format", async (req: Request, res: Response) => {
  try {
    const { docId, pattern, format } = req.body;
    
    // 【验证参数】
    if (!docId || !pattern || !format) {
      return res.status(400).json({ error: "缺少 docId、pattern 或 format" });
    }
    
    // 【应用格式】
    const result = await editor.applyFormat(docId, pattern, format);
    
    res.json({ success: true, message: result });
  } catch (error) {
    console.error("应用格式失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// ================================================================
// 【表格操作路由】
// ================================================================

/**
 * 【获取文档结构概览】
 * 
 * 【功能说明】
 * 返回所有表格的大致内容（前几行preview）
 * 让Agent快速了解文档中有哪些表格，判断每个表格的作用
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/doc-operations/inspect-document-structure/:id
 * 
 * 【响应格式】
 * { success, data: { totalTables, tables: [{ tableIndex, rows, cols, preview }] } }
 * 
 * 【执行流程】
 * 1. 获取文档ID
 * 2. 调用editor.inspectDocumentStructure()
 * 3. 解析JSON结果
 * 4. 返回文档结构概览
 */
router.get("/inspect-document-structure/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    
    // 【获取文档结构概览】
    const result = await editor.inspectDocumentStructure(id);
    
    // 【解析JSON结果】
    try {
      const parsed = JSON.parse(result);
      res.json({ success: true, data: parsed });
    } catch {
      res.json({ success: true, data: result });
    }
  } catch (error) {
    console.error("获取文档结构失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 【读取表格详细内容】
 * 
 * 【功能说明】
 * 返回指定表格的完整数据（含每个单元格的文本和ref）
 * 与旧版readTable的区别：返回文本内容，Agent无需二次查询
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/doc-operations/read-table-content/:id
 * 查询参数: tableIndex（默认0）
 * 
 * 【响应格式】
 * { success, data: { tableIndex, rows, cols, cells: [{ row, col, rowspan, colspan, ref, text }] } }
 * 
 * 【执行流程】
 * 1. 获取文档ID和表格索引
 * 2. 调用editor.readTableContent()
 * 3. 解析JSON结果
 * 4. 返回表格内容
 */
router.get("/read-table-content/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const tableIndex = Number(req.query.tableIndex) || 0;
    
    // 【读取表格内容】
    const result = await editor.readTableContent(id, tableIndex);
    
    // 【解析JSON结果】
    try {
      const parsed = JSON.parse(result);
      res.json({ success: true, data: parsed });
    } catch {
      res.json({ success: true, data: result });
    }
  } catch (error) {
    console.error("读取表格内容失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 【读取表格单元格文本】
 * 
 * 【功能说明】
 * 读取指定单元格的文本内容
 * 
 * 【HTTP请求】
 * 方法: GET
 * 端点: /api/doc-operations/read-table-cell-text/:id/:cellRef
 * 
 * 【响应格式】
 * { success, data: { cellRef, text } }
 * 
 * 【执行流程】
 * 1. 获取文档ID和单元格引用
 * 2. 调用editor.readTableCellText()
 * 3. 返回单元格文本
 */
router.get("/read-table-cell-text/:id/:cellRef", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const cellRef = String(req.params.cellRef);
    
    // 【读取单元格文本】
    const text = await editor.readTableCellText(id, cellRef);
    
    res.json({ success: true, data: { cellRef, text } });
  } catch (error) {
    console.error("读取表格单元格文本失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// ================================================================
// 【导出】
// ================================================================

/**
 * 【导出路由实例】
 * 
 * 【功能说明】
 * 导出配置好的路由实例
 * 供server.ts挂载到Express应用上
 */
export default router;
