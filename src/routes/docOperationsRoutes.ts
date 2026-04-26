import express, { Request, Response, Router } from "express";

import * as editor from "../services/editor";
import * as sessionManager from "../services/session";

const router: Router = express.Router();

// 查找文本
router.post("/find", async (req: Request, res: Response) => {
  try {
    const { docId, pattern } = req.body;
    if (!docId || !pattern) {
      return res.status(400).json({ error: "缺少 docId 或 pattern" });
    }

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

// 替换文本
router.post("/replace", async (req: Request, res: Response) => {
  try {
    const { docId, targetText, replacement, replaceAll = false } = req.body;
    if (!docId || !targetText || !replacement) {
      return res.status(400).json({ error: "缺少必要参数" });
    }

    const result = replaceAll
      ? await editor.replaceAll(docId, targetText, replacement)
      : await editor.replaceFirst(docId, targetText, replacement);

    res.json(result);
  } catch (error) {
    console.error("替换失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// 获取文档纯文本
router.get("/text/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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

// 获取文档信息
router.get("/info/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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

// 保存文档（触发 Yjs 同步）
router.post("/save/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await sessionManager.saveDocumentById(id);
    res.json({ success: true, message: "文档已保存" });
  } catch (error) {
    console.error("保存失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// 保存并关闭所有会话（供 cleanup 时调用，不暴露给前端）
router.post("/save-all-sessions", async (req: Request, res: Response) => {
  try {
    await sessionManager.closeAllSessions();
    res.json({ success: true, message: "所有会话已保存并关闭" });
  } catch (error) {
    console.error("保存会话失败:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;