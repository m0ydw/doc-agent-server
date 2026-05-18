// 文档操作路由 — 提供对已打开文档的编辑操作 API
// 所有操作都通过会话管理器获取文档句柄，再调用 editor 层的 SDK 封装函数
// 前端/AI Agent 通过此路由实现对文档的查找、替换、文本提取等功能

import express, { Request, Response, Router } from "express";

import * as editor from "../services/editor";

const router: Router = express.Router();

// 查找文本 — 在文档中搜索指定 pattern 的所有匹配位置
// 输入：{ docId, pattern }
// 输出：{ success, pattern, count, positions[] }
// positions 中每个元素包含 index、text、ref（SDK 引用标识）等信息
router.post("/find", async (req: Request, res: Response) => {
  try {
    const { docId, pattern } = req.body;
    if (!docId || !pattern) {
      return res.status(400).json({ error: "缺少 docId 或 pattern" });
    }

    // 调用 editor 层查找，返回所有匹配项
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

// 替换文本 — 在文档中将 targetText 替换为 replacement
// 输入：{ docId, targetText, replacement, replaceAll? }
// replaceAll=false 时只替换第一个匹配项；replaceAll=true 时替换全部
// 输出：{ success, replaced (替换的数量) }
router.post("/replace", async (req: Request, res: Response) => {
  try {
    const { docId, targetText, replacement, replaceAll = false } = req.body;
    if (!docId || !targetText || !replacement) {
      return res.status(400).json({ error: "缺少必要参数" });
    }

    // 根据 replaceAll 参数选择替换策略
    const result = replaceAll
      ? await editor.replaceAll(docId, targetText, replacement)
      : await editor.replaceFirst(docId, targetText, replacement);

    res.json(result);
  } catch (error) {
    console.error("替换失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// 获取文档纯文本 — 返回文档的完整文本内容（不含格式）
// 主要用于 AI 分析、全文搜索等需要纯文本的场景
router.get("/text/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
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

// 获取文档信息 — 返回文档的结构化信息（如页数、段落数、表格数等元数据）
// 供 AI Agent 在分析阶段快速了解文档结构
router.get("/info/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
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
// 新增 SDK 操作路由 — 文本编辑 / 格式 / 表格
// ================================================================

// 设置文本 — 在文档指定 ref 位置写入文本
// 输入：{ docId, ref, text }
// ref 来自 findText 返回的 positions[].ref，用于精确定位
router.post("/set-text", async (req: Request, res: Response) => {
  try {
    const { docId, ref, text } = req.body;
    if (!docId || !ref || text === undefined) {
      return res.status(400).json({ error: "缺少 docId、ref 或 text" });
    }
    const result = await editor.setText(docId, ref, text);
    res.json({ success: true, message: result });
  } catch (error) {
    console.error("设置文本失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// 应用格式 — 查找匹配文本并应用格式（加粗/斜体/下划线/删除线）
// 输入：{ docId, pattern, format: { bold?, italic?, underline?, strike? } }
// format 的每个属性值为 "on" 或 "off"
router.post("/apply-format", async (req: Request, res: Response) => {
  try {
    const { docId, pattern, format } = req.body;
    if (!docId || !pattern || !format) {
      return res.status(400).json({ error: "缺少 docId、pattern 或 format" });
    }
    const result = await editor.applyFormat(docId, pattern, format);
    res.json({ success: true, message: result });
  } catch (error) {
    console.error("应用格式失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// ================================================================
// 表格操作路由 — Agent 友好的工具
// ================================================================

// 获取文档结构概览 — 返回所有表格的大致内容（前几行 preview）
// 让 Agent 快速了解文档中有哪些表格，判断每个表格的作用
// 入参：URL 参数 id（docId）
// 返回：{ totalTables, tables: [{ tableIndex, rows, cols, preview }] }
router.get("/inspect-document-structure/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const result = await editor.inspectDocumentStructure(id);
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

// 读取表格详细内容 — 返回指定表格的完整数据（含每个单元格的文本和 ref）
// 与旧版 readTable 的区别：返回文本内容，Agent 无需二次查询
// 入参：URL 参数 id（docId），查询参数 tableIndex（默认 0）
// 返回：{ tableIndex, rows, cols, cells: [{ row, col, rowspan, colspan, ref, text }] }
router.get("/read-table-content/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const tableIndex = Number(req.query.tableIndex) || 0;
    const result = await editor.readTableContent(id, tableIndex);
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

router.get("/read-table-cell-text/:id/:cellRef", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const cellRef = String(req.params.cellRef);
    const text = await editor.readTableCellText(id, cellRef);
    res.json({ success: true, data: { cellRef, text } });
  } catch (error) {
    console.error("读取表格单元格文本失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
