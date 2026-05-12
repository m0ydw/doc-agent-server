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

export default router;