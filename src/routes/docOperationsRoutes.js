const express = require("express");
const router = express.Router();
const {
  findTextPositions,
  findAllOccurrences,
  replaceFirstOccurrence,
  replaceAllOccurrences,
  getDocumentText,
  getDocumentInfo,
} = require("../services/docOperations");

router.post("/find", async (req, res) => {
  try {
    const { docId, pattern } = req.body;
    if (!docId || !pattern) {
      return res.status(400).json({ error: "缺少 docId 或 pattern" });
    }

    const positions = await findTextPositions(docId, pattern);
    res.json({
      success: true,
      pattern,
      count: positions.length,
      positions,
    });
  } catch (error) {
    console.error("查找失败:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/replace", async (req, res) => {
  try {
    const { docId, targetText, replacement, replaceAll = false } = req.body;
    if (!docId || !targetText || !replacement) {
      return res.status(400).json({ error: "缺少必要参数" });
    }

    const result = replaceAll
      ? await replaceAllOccurrences(docId, targetText, replacement)
      : await replaceFirstOccurrence(docId, targetText, replacement);

    res.json(result);
  } catch (error) {
    console.error("替换失败:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/text/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const text = await getDocumentText(id);
    res.json({
      success: true,
      text,
    });
  } catch (error) {
    console.error("获取文本失败:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/info/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const info = await getDocumentInfo(id);
    res.json({
      success: true,
      info,
    });
  } catch (error) {
    console.error("获取信息失败:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;