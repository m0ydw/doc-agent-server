const { spawn } = require("child_process");

const SUPERDOC_CLI =
  "C:\\Users\\wkh\\AppData\\Local\\Programs\\Python\\Python313\\Lib\\site-packages\\superdoc_sdk_cli_windows_x64\\bin\\superdoc.exe";

const DOCS_DIR = require("path").join(__dirname, "../../uploads");

/**
 * 执行 superdoc CLI 命令
 * @param {string[]} args - CLI 参数数组
 * @returns {Promise<string>} - 命令输出
 */
function runCommand(args) {
  return new Promise((resolve, reject) => {
    const cli = spawn(SUPERDOC_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // 禁用 telemetry，避免输出前缀 [super-editor] Telemetry: enabled
      env: { ...process.env, DISABLE_TELEMETRY: "1" },
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

/**
 * 打开文档并过滤第一行前缀
 * @param {string} docPath - 文档路径
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>} - 解析后的 JSON 结果
 */
async function openWithSession(docPath, sessionId) {
  const output = await runCommand(["open", docPath, "--session", sessionId]);

  // 过滤第一行前缀（仅第一个命令会输出 [super-editor] Telemetry: enabled）
  const lines = output.split("\n");
  let cleanOutput = output;
  if (lines.length > 0 && (lines[0].includes("[super-editor]") || lines[0].includes("[superdoc]"))) {
    cleanOutput = lines.slice(1).join("\n").trim();
  }

  return JSON.parse(cleanOutput);
}

/**
 * 关闭会话
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>}
 */
async function closeSession(sessionId) {
  const output = await runCommand(["close", "--session", sessionId]);
  const lines = output.split("\n");
  if (lines.length > 0 && (lines[0].includes("[super-editor]") || lines[0].includes("[superdoc]"))) {
    return JSON.parse(lines.slice(1).join("\n").trim());
  }
  return JSON.parse(output);
}

/**
 * 保存会话
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>}
 */
async function saveSession(sessionId) {
  const output = await runCommand(["save", "--session", sessionId]);
  const lines = output.split("\n");
  if (lines.length > 0 && (lines[0].includes("[super-editor]") || lines[0].includes("[superdoc]"))) {
    return JSON.parse(lines.slice(1).join("\n").trim());
  }
  return JSON.parse(output);
}

/**
 * 执行查询命令并解析 JSON
 * @param {string[]} args - CLI 参数数组
 * @returns {Promise<object>}
 */
async function runQuery(args) {
  const output = await runCommand(args);
  return JSON.parse(output);
}

module.exports = {
  runCommand,
  openWithSession,
  closeSession,
  saveSession,
  runQuery,
  DOCS_DIR,
};
