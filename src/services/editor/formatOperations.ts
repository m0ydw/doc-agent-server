/**
 * 结构化编辑操作（填表专用）
 * 基于 SuperDoc SDK mutations.apply API
 */

import * as sessionManager from "../../services/session";

async function getSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}

/** 在指定位置写入文本，保留原格式 */
export async function setText(docId: string, ref: string, text: string): Promise<string> {
  const doc = await getSession(docId);
  await doc.mutations.apply({
    atomic: true,
    steps: [{
      id: "set-text",
      op: "text.rewrite",
      where: { by: "ref", ref },
      args: {
        replacement: { text },
        style: { inline: { mode: "preserve" } },
      },
    }],
  });
  return `已写入: "${text}"`;
}

/** 查找文本并应用格式（粗体/颜色等） */
export async function applyFormat(
  docId: string,
  pattern: string,
  format: { bold?: "on" | "off"; italic?: "on" | "off"; underline?: "on" | "off"; strike?: "on" | "off" }
): Promise<string> {
  const doc = await getSession(docId);
  const matchResult = await doc.query.match({
    select: { type: "text", pattern },
    require: "any",
  });
  if (!matchResult.items || matchResult.items.length === 0) {
    return `未找到匹配"${pattern}"`;
  }
  const steps = matchResult.items
    .filter((item: { handle?: { ref?: string }; text?: string; content?: string }) => item.handle?.ref)
    .map((item: { handle: { ref: string }; text?: string; content?: string }, i: number) => ({
      id: "fmt-" + i,
      op: "text.rewrite" as const,
      where: { by: "ref" as const, ref: item.handle.ref },
      args: {
        replacement: { text: item.text || item.content || "" },
        style: { inline: { mode: "set" as const, setMarks: format } },
      },
    }));
  await doc.mutations.apply({ atomic: true, steps });
  const desc = Object.entries(format).map(([k, v]) => `${k}=${v}`).join(",");
  return `已对 ${steps.length} 处"${pattern}"应用格式: ${desc}`;
}

/** 提取文档结构（表格/段落位置），供 LLM 定位填充字段 */
export async function getStructure(docId: string): Promise<string> {
  const doc = await getSession(docId);
  // 查表格
  const tables = await doc.query.match({
    select: { type: "node", nodeType: "table" },
    require: "any",
  });
  // 查段落
  const paragraphs = await doc.query.match({
    select: { type: "node", nodeType: "paragraph" },
    require: "any",
  });

  const lines: string[] = [];
  if (tables.items?.length > 0) {
    lines.push(`表格: ${tables.items.length} 个`);
  }
  if (paragraphs.items?.length > 0) {
    const sample = paragraphs.items.slice(0, 10).map(
      (p: { text?: string; handle?: { ref: string } }, i: number) =>
        `  [${i}] ref=${p.handle?.ref?.slice(0,16)} text="${(p.text || "").slice(0, 40)}"`
    ).join("\n");
    lines.push(`段落: ${paragraphs.items.length} 个\n${sample}`);
  }
  return lines.join("\n") || "未发现表格或段落";
}
