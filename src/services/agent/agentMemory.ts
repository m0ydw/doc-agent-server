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
  if (!/(记住|以后|后续|默认|偏好|总是|每次|不要全文|先定位|样式.*检查)/.test(prompt)) {
    return null;
  }
  return `用户偏好/约束：${prompt}`;
}

export async function persistRunMemory(run: AgentRun, finalText: string): Promise<void> {
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
