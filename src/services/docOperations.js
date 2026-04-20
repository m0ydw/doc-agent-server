const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const DOCS_DIR = path.join(__dirname, "../../uploads");
const SUPERDOC_CLI = "C:\\Users\\wkh\\AppData\\Local\\Programs\\Python\\Python313\\Lib\\site-packages\\superdoc_sdk_cli_windows_x64\\bin\\superdoc.exe";

function runCommand(args) {
  return new Promise((resolve, reject) => {
    const cli = spawn(SUPERDOC_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    cli.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    cli.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    cli.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `命令失败: ${code}`));
      }
    });

    cli.on("error", (err) => {
      reject(err);
    });
  });
}

// 使用 open -> 操作 -> save -> close 流程
async function withDocumentSession(docPath, callback) {
  const sessionId = `session-${Date.now()}`;

  try {
    // 1. 打开文档
    await runCommand(["open", docPath, "--session", sessionId]);

    // 2. 执行回调函数（传入 sessionId）
    await callback(sessionId);

    // 3. 保存文档
    await runCommand(["save", "--session", sessionId]);
  } finally {
    // 4. 关闭会话
    try {
      await runCommand(["close", "--session", sessionId]);
    } catch (e) {
      console.error("关闭会话失败:", e.message);
    }
  }
}

async function findTextPositions(docId, pattern) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    let result = [];

    await withDocumentSession(docPath, async (sessionId) => {
      // v1: 使用 query match 查找（不是 find）
      const selectJson = JSON.stringify({
        type: "text",
        pattern: pattern
      });

      const output = await runCommand([
        "query", "match",
        "--select-json", selectJson,
        "--session", sessionId
      ]);

      const data = JSON.parse(output);
      // v1 返回格式: data.data.items[]
      if (!data.ok || !data.data?.items || data.data.items.length === 0) {
        return;
      }

      result = data.data.items.map((item, index) => ({
        index,
        text: item.text || item.content || item.handle?.text || "",
        ref: item.handle?.ref || "",
        evaluatedRevision: data.data.evaluatedRevision
      }));
    });

    return result;
  } catch (e) {
    console.error("查找失败:", e.message);
    return [];
  }
}

async function findAllOccurrences(docId, text) {
  return findTextPositions(docId, text);
}

// 使用 query match + mutations apply 的 v1 正确流程
async function replaceFirstOccurrence(docId, targetText, replacement) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    let ref = null;

    await withDocumentSession(docPath, async (sessionId) => {
      // 1. 先用 query match 找到目标的 ref
      const selectJson = JSON.stringify({
        type: "text",
        pattern: targetText,
        require: "first"
      });

      const matchOutput = await runCommand([
        "query",
        "match",
        "--select-json", selectJson,
        "--session", sessionId
      ]);

      const matchData = JSON.parse(matchOutput);
      if (!matchData.ok || !matchData.data?.items || matchData.data.items.length === 0) {
        throw new Error("未找到匹配内容");
      }

      // 获取 ref 和 evaluatedRevision 用于替换
      ref = matchData.data.items[0]?.handle?.ref;
      const evaluatedRevision = matchData.data.evaluatedRevision;
      if (!ref) {
        throw new Error("无法获取替换位置");
      }

      // 2. 使用 mutations apply 进行替换（v1 正确方式）
      const mutations = JSON.stringify([{
        id: "replace-1",
        op: "text.rewrite",
        where: { by: "ref", ref: ref },
        args: { replacement: { text: replacement } }
      }]);

      await runCommand([
        "mutations", "apply",
        "--mutations", mutations,
        "--session", sessionId
      ]);
    });

    return { success: true, replaced: 1 };
  } catch (e) {
    console.error("替换失败:", e.message);
    return { success: false, message: e.message };
  }
}

async function replaceAllOccurrences(docId, targetText, replacement) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    let replacedCount = 0;

    await withDocumentSession(docPath, async (sessionId) => {
      // 使用 query match 查找所有匹配项
      const selectJson = JSON.stringify({
        type: "text",
        pattern: targetText
      });

      const matchOutput = await runCommand([
        "query",
        "match",
        "--select-json", selectJson,
        "--session", sessionId
      ]);

      const matchData = JSON.parse(matchOutput);
      if (!matchData.ok || !matchData.data?.items || matchData.data.items.length === 0) {
        return;
      }

      const items = matchData.data.items;

      // v1: 批量替换 - 构造所有 mutations
      const mutations = items.map((item, index) => {
        const ref = item?.handle?.ref;
        if (!ref) return null;
        return {
          id: `replace-${index}`,
          op: "text.rewrite",
          where: { by: "ref", ref: ref },
          args: { replacement: { text: replacement } }
        };
      }).filter(Boolean);

      if (mutations.length === 0) {
        return;
      }

      // v1: 使用 mutations apply 进行批量替换
      await runCommand([
        "mutations", "apply",
        "--mutations", JSON.stringify(mutations),
        "--session", sessionId
      ]);

      replacedCount = mutations.length;
    });

    return { success: true, replaced: replacedCount };
  } catch (e) {
    console.error("替换失败:", e.message);
    return { success: false, message: e.message };
  }
}

async function getDocumentText(docId) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    let text = "";

    await withDocumentSession(docPath, async (sessionId) => {
      const output = await runCommand(["get-text", "--session", sessionId]);
      text = output.trim();
    });

    return text;
  } catch (e) {
    throw new Error("获取文本失败: " + e.message);
  }
}

async function getDocumentInfo(docId) {
  const docPath = path.join(DOCS_DIR, `${docId}.docx`);
  if (!fs.existsSync(docPath)) {
    throw new Error("文档不存在");
  }

  try {
    let info = null;

    await withDocumentSession(docPath, async (sessionId) => {
      const output = await runCommand(["info", "--session", sessionId]);
      info = JSON.parse(output);
    });

    return info;
  } catch (e) {
    throw new Error("获取信息失败: " + e.message);
  }
}

module.exports = {
  findTextPositions,
  findAllOccurrences,
  replaceFirstOccurrence,
  replaceAllOccurrences,
  getDocumentText,
  getDocumentInfo,
};