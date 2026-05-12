// 格式操作 — 文档的高级编辑操作（格式设置、表格读写、单元格查找等）
// 与 editorOperations.ts 互补：editorOperations 负责基本查找/替换，本文件负责格式和结构操作
// 所有操作均通过会话管理器获取 SDK 文档句柄

import * as sessionManager from "../../services/session";

// getSession — 获取 SDK 文档句柄的内部 helper
async function getSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}

// setText — 在文档指定 ref 位置写入文本
// 使用 text.rewrite 操作和 by:"ref" 精确定位
// style.inline.mode = "preserve" 表示保留目标位置的原有格式
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

// applyFormat — 查找匹配文本并应用格式（加粗/斜体/下划线/删除线）
// 流程：match 找到所有匹配 → 为每个匹配生成 text.rewrite step → 批量 apply
// setMarks 参数直接传递格式键值对（如 { bold: "on", italic: "off" }）
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

// readTable — 结构化读取表格数据供 LLM 推理
// 流程：获取表格块 → 获取维度 → 获取单元格坐标（含合并信息）→ 组装 JSON 输出
// 注意：仅返回坐标和 ref，不包含文本内容 — 文本由 LLM 通过 findText 单独验证
// 这样设计是为了控制输出体积，避免 LLM context 被大表格撑满
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

// getStructure — 获取文档结构（兼容旧接口，默认读取第一个表格）
export async function getStructure(docId: string): Promise<string> {
  return await readTable(docId, 0);
}

// findCell — 查找包含指定文本的表格单元格
// 先用 doc.query.match 按 tableCell 节点类型匹配所有单元格
// 然后遍历比对文本内容，返回匹配单元格的 ref 和文本预览
// 输出提示帮助 LLM 理解目标填充位置（通常位于匹配单元格的右侧或下方）
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
