import * as sessionManager from "../../services/session";

async function getSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}

/** 在指定位置写入文本 */
export async function setText(docId: string, ref: string, text: string): Promise<string> {
  const doc = await getSession(docId);
  await doc.mutations.apply({
    atomic: true,
    steps: [{
      id: "set-text",
      op: "text.rewrite",
      where: { by: "ref", ref },
      args: { replacement: { text }, style: { inline: { mode: "preserve" } } },
    }],
  });
  return `已写入: "${text}"`;
}

/** 查找文本并应用格式 */
export async function applyFormat(
  docId: string, pattern: string,
  format: { bold?: "on" | "off"; italic?: "on" | "off"; underline?: "on" | "off"; strike?: "on" | "off" }
): Promise<string> {
  const doc = await getSession(docId);
  const matchResult = await doc.query.match({ select: { type: "text", pattern }, require: "any" });
  if (!matchResult.items?.length) return `未找到匹配"${pattern}"`;
  const steps = matchResult.items
    .filter((item: { handle?: { ref?: string }; text?: string; content?: string }) => item.handle?.ref)
    .map((item: { handle: { ref: string }; text?: string; content?: string }, i: number) => ({
      id: "fmt-" + i, op: "text.rewrite" as const,
      where: { by: "ref" as const, ref: item.handle.ref },
      args: { replacement: { text: item.text || item.content || "" }, style: { inline: { mode: "set" as const, setMarks: format } } },
    }));
  await doc.mutations.apply({ atomic: true, steps });
  const desc = Object.entries(format).map(([k, v]) => `${k}=${v}`).join(",");
  return `已对 ${steps.length} 处"${pattern}"应用格式: ${desc}`;
}

/** 结构化读取表格 — 返回 JSON 格式的完整表格地图供 LLM 推理 */
export async function readTable(docId: string, tableIndex: number = 0): Promise<string> {
  const doc = await getSession(docId);
  // 1. 获取所有表格块
  const tableBlocks = await doc.blocks.list({ nodeTypes: ["table"], offset: tableIndex, limit: 1 } as Record<string, unknown>);
  const blocks = (tableBlocks as Record<string, unknown>).blocks as Array<{ nodeId: string }> | undefined;
  if (!blocks?.length) return JSON.stringify({ error: `未找到表格 #${tableIndex}` });
  const target = { kind: "block", nodeType: "table", nodeId: blocks[0].nodeId };

  // 2. 获取表格维度
  const tableInfo = await doc.tables.get({ target });
  const rows = (tableInfo as Record<string, unknown>).rows as number || 0;
  const cols = (tableInfo as Record<string, unknown>).columns as number || 0;

  // 3. 获取单元格坐标（含合并信息）
  const cellsResult = await doc.tables.getCells({ target });
  const cells = ((cellsResult as Record<string, unknown>).cells || []) as Array<{
    nodeId: string; rowIndex: number; columnIndex: number; colspan: number; rowspan: number;
  }>;

  // 4. 获取写入 ref（仅取 ref，不取 text——text 由 LLM 通过 sdk_find_text 自行验证）
  const refBlocks = await doc.blocks.list({ nodeTypes: ["tableCell"], limit: 500 } as Record<string, unknown>);
  const refBlocksArr = ((refBlocks as Record<string, unknown>).blocks || []) as Array<{ nodeId?: string; ref?: string }>;
  const refMap = new Map<string, string>();
  for (const b of refBlocksArr) {
    if (b.nodeId && b.ref) refMap.set(b.nodeId, b.ref);
  }

  // 5. 组装结构化输出（坐标 + ref，无 text）
  const result = { tableIndex, rows, cols, cells: [] as Record<string, unknown>[] };
  for (const c of cells) {
    result.cells.push({
      row: c.rowIndex, col: c.columnIndex,
      colspan: c.colspan, rowspan: c.rowspan,
      ref: refMap.get(c.nodeId) || c.nodeId,
    });
  }
  return JSON.stringify(result, null, 2);
}

/** 兼容旧接口 */
export async function getStructure(docId: string): Promise<string> {
  return await readTable(docId, 0);
}

/** 查找包含指定文本的单元格 */
export async function findCell(docId: string, pattern: string): Promise<string> {
  const doc = await getSession(docId);
  const cells = await doc.query.match({ select: { type: "node", nodeType: "tableCell" }, require: "any" });
  if (!((cells as Record<string, unknown>).items as unknown[])?.length) return `未找到表格`;
  const items = (cells as Record<string, unknown>).items as Array<{ text?: string; content?: string; handle?: { ref?: string } }>;
  const matched: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const txt = (c.text || c.content || "").toLowerCase();
    if (txt.includes(pattern.toLowerCase())) {
      matched.push(`[${i}] ref=${(c.handle?.ref || "").slice(0, 16)} text="${(c.text || c.content || "").replace(/\n/g, " ").slice(0, 60)}"`);
    }
  }
  if (!matched.length) return `未找到包含"${pattern}"的单元格`;
  return `找到 ${matched.length} 个:\n${matched.join("\n")}\n\n提示: 目标填充格通常在匹配单元格的右侧或下方。`;
}
