/**
 * ============================================================
 * 【Agent记忆模块 - agentMemory.ts】
 * ============================================================
 *
 * 【链路式工程流说明】
 * 这是Agent记忆的核心模块，负责：
 * 1. 管理Agent的历史记忆
 * 2. 持久化存储用户偏好和任务总结
 * 3. 提供相关记忆的检索
 * 4. 生成记忆摘要供Agent参考
 *
 * 【架构位置】
 * agentRunner.ts → 【agentMemory.ts】 → 文件系统
 *
 * 【数据流】
 * agentRunner调用persistRunMemory()
 *   ↓
 * 提取任务总结
 *   ↓
 * 写入memory.jsonl文件
 *
 * agentRunner调用summarizeRelevantMemory()
 *   ↓
 * 读取相关记忆
 *   ↓
 * 生成摘要供Agent参考
 *
 * 【存储格式】
 * 使用JSONL格式（每行一个JSON对象）
 * 存储在data/agent-memory/memory.jsonl文件中
 *
 * 【记忆类型】
 * - user_preference: 用户偏好
 * - document_task_summary: 文档任务总结
 * - tool_call_summary: 工具调用总结
 *
 * 【导出的函数】
 * - loadAgentMemory: 加载Agent记忆
 * - persistRunMemory: 持久化运行记忆
 * - summarizeRelevantMemory: 总结相关记忆
 *
 * 【使用的模块】
 * fs/promises: Node.js文件系统模块（Promise版本）
 *   - mkdir: 创建目录
 *   - readFile: 读取文件
 *   - appendFile: 追加文件
 *
 * path: Node.js路径模块
 *   - 路径处理
 *
 * ./agentTypes: Agent类型定义
 *   - AgentEvent: Agent事件类型
 *   - AgentRun: Agent运行实例类型
 * ============================================================
 */

// ... (原始文件内容)
import { mkdir, readFile, appendFile } from "fs/promises";
import path from "path";
import type { AgentEvent, AgentRun } from "./agentTypes";

export type AgentMemoryEntry = {
  id: string;
  ts: number;
  scope: "global" | "document";
  kind: "user_preference" | "document_task_summary" | "tool_call_summary";
  documentNames?: string[];
  text: string;
};

const MEMORY_DIR = path.join(process.cwd(), "data", "agent-memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "memory.jsonl");
const MAX_ENTRY_TEXT = 600;
const MAX_SUMMARY_TEXT = 1800;

function clampText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 3)}...`
    : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeParseLine(line: string): AgentMemoryEntry | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || typeof value.text !== "string") return null;
    return value as AgentMemoryEntry;
  } catch {
    return null;
  }
}

async function ensureMemoryDir(): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
}

export async function loadAgentMemory(scope?: {
  documentNames?: string[];
  limit?: number;
}): Promise<AgentMemoryEntry[]> {
  try {
    const raw = await readFile(MEMORY_FILE, "utf8");
    const entries = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(safeParseLine)
      .filter((entry): entry is AgentMemoryEntry => Boolean(entry));
    const names = new Set(
      scope?.documentNames?.map((name) => name.trim().toLowerCase()) ?? [],
    );
    const filtered = names.size
      ? entries.filter(
          (entry) =>
            entry.scope === "global" ||
            entry.documentNames?.some((name) =>
              names.has(name.trim().toLowerCase()),
            ),
        )
      : entries;
    return filtered.slice(-(scope?.limit ?? 30));
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

export async function appendAgentMemory(
  entry: Omit<AgentMemoryEntry, "id" | "ts" | "text"> & { text: string },
): Promise<void> {
  await ensureMemoryDir();
  const stored: AgentMemoryEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    text: clampText(entry.text, MAX_ENTRY_TEXT),
  };
  await appendFile(MEMORY_FILE, `${JSON.stringify(stored)}\n`, "utf8");
}

export async function summarizeRelevantMemory(run: AgentRun): Promise<string> {
  const entries = await loadAgentMemory({
    documentNames: run.documents.map((doc) => doc.name),
    limit: 20,
  });
  if (!entries.length) {
    return "Agent memory: no saved preferences or prior summaries.";
  }

  const lines = entries.map((entry) => {
    const date = new Date(entry.ts).toISOString().slice(0, 10);
    return `- [${entry.kind}, ${date}] ${entry.text}`;
  });
  return clampText(`Agent memory:\n${lines.join("\n")}`, MAX_SUMMARY_TEXT);
}

function compactToolEvent(event: AgentEvent): string | null {
  if (event.type !== "tool.finished") return null;
  const name = String(event.payload.name ?? "");
  if (!name || name === "get_text") return null;
  const status = String(event.payload.status ?? "");
  const summary = String(event.payload.summary ?? "");
  return `${name}: ${status}. ${summary}`;
}

function extractPreference(prompt: string): string | null {
  if (
    !/(记住|以后|后续|默认|偏好|总是|每次|不要全文|先定位|样式.*检查)/.test(
      prompt,
    )
  ) {
    return null;
  }
  return `用户偏好/约束：${prompt}`;
}

export async function persistRunMemory(
  run: AgentRun,
  finalText: string,
): Promise<void> {
  const documentNames = run.documents.map((doc) => doc.name);
  const preference = extractPreference(run.prompt);
  if (preference) {
    await appendAgentMemory({
      scope: "global",
      kind: "user_preference",
      documentNames,
      text: preference,
    });
  }

  const toolSummaries = run.events
    .map(compactToolEvent)
    .filter((item): item is string => Boolean(item))
    .slice(-12);
  if (toolSummaries.length) {
    await appendAgentMemory({
      scope: documentNames.length ? "document" : "global",
      kind: "tool_call_summary",
      documentNames,
      text: toolSummaries.join(" | "),
    });
  }

  await appendAgentMemory({
    scope: documentNames.length ? "document" : "global",
    kind: "document_task_summary",
    documentNames,
    text: `任务：${run.prompt}；结果：${finalText || "已完成，无最终文本。"}`,
  });
}
