/**
 * Agent 调试日志模块
 * 
 * 通过环境变量 AGENT_DEBUG_LOG 控制开关
 * - true: 开启详细日志
 * - false 或未设置: 关闭日志（默认）
 * 
 * 日志类型：
 * - 用户输入
 * - System Prompt
 * - 文档上下文
 * - 工具列表
 * - LLM 流式文本（实时打印）
 * - LLM 工具调用决策（LLM 调用工具前的输出）
 * - 工具入参
 * - 工具返回值
 * - LLM 最终输出
 */

// 环境变量读取
const AGENT_DEBUG_LOG = process.env.AGENT_DEBUG_LOG === "true";

// ANSI 颜色码（避免额外依赖）
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

// 分隔线
const SEPARATOR = "━".repeat(60);
const THIN_SEPARATOR = "─".repeat(40);

/**
 * 获取当前时间戳字符串
 */
function getTimestamp(): string {
  return new Date().toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * 截断超长内容
 */
function truncate(text: string, maxLength: number = 800): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n${colors.dim}... (已截断，总长度: ${text.length} 字符)${colors.reset}`;
}

/**
 * 格式化 JSON 对象为可读字符串
 */
function formatJson(obj: unknown, maxLength: number = 600): string {
  try {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    return truncate(text, maxLength);
  } catch {
    return String(obj);
  }
}

// ============================================================
// 日志输出函数（所有函数在 AGENT_DEBUG_LOG=false 时直接返回）
// ============================================================

/**
 * 打印日志标题（每次 Agent 运行开始时调用）
 */
export function logAgentStart(runId: string): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `\n${colors.bright}${colors.cyan}${SEPARATOR}${colors.reset}`,
  );
  console.log(
    `${colors.bright}${colors.cyan}[Agent Debug]${colors.reset} ${colors.gray}${getTimestamp()}${colors.reset} ${colors.dim}runId: ${runId}${colors.reset}`,
  );
  console.log(
    `${colors.bright}${colors.cyan}${SEPARATOR}${colors.reset}\n`,
  );
}

/**
 * 打印用户输入
 */
export function logUserInput(prompt: string): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(`${colors.bright}${colors.green}📥 用户输入:${colors.reset}`);
  console.log(`   ${colors.white}${prompt}${colors.reset}\n`);
}

/**
 * 打印 System Prompt
 */
export function logSystemPrompt(prompt: string): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(`${colors.bright}${colors.yellow}📋 System Prompt:${colors.reset}`);
  console.log(
    `   ${colors.dim}${truncate(prompt, 500)}${colors.reset}\n`,
  );
}

/**
 * 打印文档上下文
 */
export function logDocumentContext(context: string): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(`${colors.bright}${colors.blue}📄 文档上下文:${colors.reset}`);
  console.log(`   ${colors.white}${context}${colors.reset}\n`);
}

/**
 * 打印工具列表
 */
export function logToolList(tools: Record<string, unknown>): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(`${colors.bright}${colors.magenta}🔧 可用工具列表:${colors.reset}`);
  for (const [name, toolDef] of Object.entries(tools)) {
    const description =
      typeof toolDef === "object" && toolDef !== null && "description" in toolDef
        ? (toolDef as { description: string }).description
        : "无描述";
    console.log(
      `   ${colors.cyan}• ${name}${colors.reset}: ${colors.dim}${description}${colors.reset}`,
    );
  }
  console.log("");
}

/**
 * 打印 LLM 流式文本块（实时，不换行）
 */
export function logStreamChunk(text: string): void {
  if (!AGENT_DEBUG_LOG) return;

  // 使用 stdout.write 实现实时打印，不自动换行
  process.stdout.write(`${colors.white}${text}${colors.reset}`);
}

/**
 * 打印 LLM 流式文本结束标记
 */
export function logStreamEnd(): void {
  if (!AGENT_DEBUG_LOG) return;

  // 流结束后换行
  process.stdout.write("\n\n");
}

/**
 * 打印 LLM 工具调用决策（LLM 决定调用工具前的输出/思考）
 */
export function logToolCallDecision(text: string): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `${colors.bright}${colors.cyan}🤖 LLM 工具调用决策:${colors.reset}`,
  );
  console.log(
    `   ${colors.white}${truncate(text, 300)}${colors.reset}`,
  );
  console.log(`   ${colors.dim}${THIN_SEPARATOR}${colors.reset}`);
}

/**
 * 打印工具调用开始（包含工具名）
 */
export function logToolCall(toolName: string): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `${colors.bright}${colors.cyan}🔍 调用工具:${colors.reset} ${colors.bright}${toolName}${colors.reset}`,
  );
}

/**
 * 打印工具入参
 */
export function logToolInput(input: unknown): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(`${colors.bright}${colors.yellow}📥 工具入参:${colors.reset}`);
  console.log(
    `   ${colors.white}${formatJson(input)}${colors.reset}\n`,
  );
}

/**
 * 打印工具返回值
 */
export function logToolOutput(output: unknown): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(`${colors.bright}${colors.green}📤 工具返回值:${colors.reset}`);
  console.log(
    `   ${colors.white}${formatJson(output, 400)}${colors.reset}\n`,
  );
}

/**
 * 打印工具错误
 */
export function logToolError(toolName: string, error: unknown): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `${colors.bright}${colors.red}❌ 工具错误 [${toolName}]:${colors.reset}`,
  );
  console.log(
    `   ${colors.red}${error instanceof Error ? error.message : String(error)}${colors.reset}\n`,
  );
}

/**
 * 打印 LLM 最终输出
 */
export function logFinalOutput(text: string): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `${colors.bright}${colors.green}✅ LLM 最终输出:${colors.reset}`,
  );
  console.log(`   ${colors.white}${text}${colors.reset}\n`);
  console.log(
    `${colors.bright}${colors.cyan}${SEPARATOR}${colors.reset}`,
  );
  console.log(
    `${colors.dim}[Agent Debug] 结束 ${getTimestamp()}${colors.reset}`,
  );
  console.log(
    `${colors.bright}${colors.cyan}${SEPARATOR}${colors.reset}\n`,
  );
}

/**
 * 打印 Agent 执行步数
 */
export function logStep(stepNumber: number): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `${colors.bright}${colors.blue}📍 执行步骤: ${stepNumber + 1}${colors.reset}`,
  );
  console.log(`   ${colors.dim}${THIN_SEPARATOR}${colors.reset}`);
}

/**
 * 打印 Agent 完成信息
 */
export function logAgentFinish(finishReason: string, usage?: unknown): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `${colors.bright}${colors.green}🏁 Agent 完成:${colors.reset} ${colors.white}${finishReason}${colors.reset}`,
  );
  if (usage) {
    console.log(
      `   ${colors.dim}Token 用量: ${formatJson(usage, 200)}${colors.reset}`,
    );
  }
  console.log("");
}

/**
 * 打印 Agent 错误
 */
export function logAgentError(error: unknown): void {
  if (!AGENT_DEBUG_LOG) return;

  console.log(
    `${colors.bright}${colors.red}💥 Agent 错误:${colors.reset}`,
  );
  console.log(
    `   ${colors.red}${error instanceof Error ? error.message : String(error)}${colors.reset}\n`,
  );
}
