import * as sessionManager from "../../services/session";

async function getSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}

export type MutationChangeMode = "tracked" | "direct";

export interface MutationApplyOptions {
  changeMode?: MutationChangeMode;
}

function buildApplyParams(steps: any[], options?: MutationApplyOptions): any {
  return {
    atomic: true,
    ...(options?.changeMode ? { changeMode: options.changeMode } : {}),
    steps,
  };
}

function textRewriteStep(id: string, ref: string, text: string) {
  return {
    id,
    op: "text.rewrite",
    where: { by: "ref", ref },
    args: {
      replacement: { text },
      style: { inline: { mode: "preserve" } },
    },
  };
}

async function applyTextRewrite(
  doc: any,
  ref: string,
  text: string,
  stepId: string,
  options?: MutationApplyOptions,
): Promise<void> {
  await doc.mutations.apply(
    buildApplyParams([textRewriteStep(stepId, ref, text)], options),
  );
}

//根据ref写入text
export async function setText(
  docId: string,
  ref: string,
  text: string,
  options?: MutationApplyOptions,
): Promise<string> {
  const doc = await getSession(docId);
  await applyTextRewrite(doc, ref, text, "set-text", options);
  return `已写入: "${text}"`;
}

export async function applyFormat(
  docId: string,
  pattern: string,
  format: {
    bold?: "on" | "off";
    italic?: "on" | "off";
    underline?: "on" | "off";
    strike?: "on" | "off";
  },
): Promise<string> {
  const doc = await getSession(docId);
  const matchResult = await doc.query.match({
    select: { type: "text", pattern },
    require: "any",
  });
  if (!matchResult.items?.length) return `未找到匹配 "${pattern}"`;

  const steps = matchResult.items
    .filter(
      (item: { handle?: { ref?: string }; text?: string; content?: string }) =>
        item.handle?.ref,
    )
    .map(
      (
        item: { handle: { ref: string }; text?: string; content?: string },
        i: number,
      ) => ({
        id: "fmt-" + i,
        op: "text.rewrite" as const,
        where: { by: "ref" as const, ref: item.handle.ref },
        args: {
          replacement: { text: item.text || item.content || "" },
          style: { inline: { mode: "set" as const, setMarks: format } },
        },
      }),
    );

  await doc.mutations.apply({ atomic: true, steps });
  const desc = Object.entries(format)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `已对 ${steps.length} 处 "${pattern}" 应用格式: ${desc}`;
}

type TableAddress = {
  kind: "block";
  nodeType: "table";
  nodeId: string;
};

type BlockAddress = {
  kind: "block";
  nodeType: "paragraph";
  nodeId: string;
};

export type TableTargetInput = {
  tableIndex?: number;
  tableRef?: string;
};

export type TableLayoutInput = {
  alignment?: "left" | "center" | "right";
  autoFitMode?: "fixedWidth" | "autoFit" | "autoFitWindow";
  preferredWidth?: number;
};

export type TableStyleOptionsInput = {
  headerRow?: boolean;
  lastRow?: boolean;
  firstColumn?: boolean;
  lastColumn?: boolean;
  bandedRows?: boolean;
  bandedColumns?: boolean;
};

export type TableBorderInput = {
  lineStyle?: string;
  lineWeightPt?: number;
  color?: string;
};

export type TableFormatInput = {
  target: TableTargetInput;
  layout?: TableLayoutInput;
  styleOptions?: TableStyleOptionsInput;
  borders?: Partial<
    Record<"top" | "bottom" | "left" | "right" | "insideH" | "insideV", TableBorderInput>
  >;
  shading?: {
    fill: string;
  };
  padding?: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
};

type RawTableCell = {
  nodeId: string;
  rowIndex: number;
  columnIndex: number;
  colspan: number;
  rowspan: number;
};

interface TableCellInfo {
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
  ref: string;
  text: string;
}

interface TextBlockInfo {
  blockIndex: number;
  ref: string;
  nodeType?: string;
  text: string;
}

/**
 * 【新增】单元格写入输入类型
 *
 * 定义写入单个单元格所需的信息：
 * - ref: 单元格的唯一标识符（来自 SDK 的 nodeId）
 * - text: 要写入的新文本内容
 * - reason: 可选，写入原因（用于审批时展示给用户）
 *
 * 【ref 的来源】
 * ref 是 SuperDoc SDK 分配的内部标识符，格式类似 "cell-123"
 * 通过 readTableContent 或 inspectDocumentStructure 获取
 */
export type CellWriteInput = {
  ref: string;
  text: string;
  reason?: string;
};

/**
 * 【新增】单元格写入结果类型
 *
 * 继承 CellWriteInput 的所有字段，并添加执行结果信息：
 * - success: 写入是否成功
 * - beforeText: 写入前的原始文本
 * - afterText: 写入后的实际文本
 * - verified: 写入后是否验证通过（afterText === text）
 * - error: 如果失败，包含错误信息
 *
 * 【为什么需要 beforeText 和 afterText】
 * - beforeText: 用于审批时展示"原文"，让用户决定是否允许修改
 * - afterText: 用于验证写入是否成功，防止 SDK 静默失败
 */
export type CellWriteResult = CellWriteInput & {
  success: boolean;
  beforeText: string;
  afterText: string;
  verified: boolean;
  changeMode?: MutationChangeMode;
  error?: string;
};

const CELL_PREVIEW_LIMIT = 20;

function normalizeText(text: unknown): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
//裁剪
function previewText(text: string): string {
  return text.length > CELL_PREVIEW_LIMIT
    ? text.slice(0, CELL_PREVIEW_LIMIT)
    : text;
}

function extractInlineText(node: unknown): string {
  if (!node || typeof node !== "object") return "";

  const record = node as Record<string, unknown>;
  const run = record.run as { text?: unknown } | undefined;
  if (run?.text != null) return String(run.text);
  if (record.text != null) return String(record.text);

  const inlines = record.inlines;
  if (Array.isArray(inlines)) return inlines.map(extractInlineText).join("");

  const children = record.children;
  if (Array.isArray(children)) return children.map(extractInlineText).join("");

  return "";
}

function extractNodeText(nodeResult: unknown): string {
  const result = nodeResult as { node?: Record<string, unknown> } | null;
  const node = result?.node;
  if (!node) return "";

  const paragraph = node.paragraph as { inlines?: unknown[] } | undefined;
  if (Array.isArray(paragraph?.inlines)) {
    return normalizeText(paragraph.inlines.map(extractInlineText).join(""));
  }

  return normalizeText(extractInlineText(node));
}
//获取某个cells
async function getTableCells(
  doc: any,
  table: TableAddress,
): Promise<RawTableCell[]> {
  const cellsResult = await doc.tables.getCells({ target: table });
  const cells = ((cellsResult as Record<string, unknown>).cells ||
    []) as RawTableCell[];
  return cells;
}

async function readCellFullTextByRef(doc: any, ref: string): Promise<string> {
  const data = await doc.getNodeById({ id: ref });
  //测试
  //tablestyle的获取
  //加到文档末尾
  // await doc.insert({ ref: "cell-auto-3ca8129e", value: "测试", type: "text" });

  //// 模式 2：target.kind = "block"
  // 在某个 block 前/后插入结构化内容
  // await doc.insert({
  //   target: {
  //     kind: "block",
  //     nodeId: "paragraph-auto-a12b34c",
  //   },
  //   position: "after",
  //   content: [
  //     {
  //       type: "paragraph",
  //       children: [
  //         {
  //           type: "text",
  //           text: "这是新插入的段落",
  //         },
  //       ],
  //     },
  //   ],
  // });

  return extractNodeText(data);
}

async function readCellPreviewTextByRef(
  doc: any,
  ref: string,
): Promise<string> {
  return previewText(await readCellFullTextByRef(doc, ref));
}

async function getTableByIndex(
  doc: any,
  tableIndex: number,
): Promise<TableAddress | null> {
  const tableBlocks = await doc.blocks.list({
    nodeTypes: ["table"],
    offset: tableIndex,
    limit: 1,
  } as Record<string, unknown>);
  const blocks = ((tableBlocks as Record<string, unknown>).blocks ||
    []) as Array<{ nodeId: string }>;
  if (!blocks.length) return null;
  return { kind: "block", nodeType: "table", nodeId: blocks[0].nodeId };
}

function getTableByRef(tableRef: string): TableAddress {
  return { kind: "block", nodeType: "table", nodeId: tableRef };
}

async function resolveTableTarget(
  doc: any,
  target: TableTargetInput,
): Promise<TableAddress | null> {
  if (target.tableRef) return getTableByRef(target.tableRef);
  return getTableByIndex(doc, target.tableIndex ?? 0);
}

async function getBlocks(
  doc: any,
  nodeTypes: string[],
  limit: number,
  offset: number,
): Promise<Array<{ nodeId: string; nodeType?: string; type?: string }>> {
  const result = await doc.blocks.list({
    nodeTypes,
    offset,
    limit,
  } as Record<string, unknown>);
  return (((result as Record<string, unknown>).blocks || []) as Array<{
    nodeId: string;
    nodeType?: string;
    type?: string;
  }>);
}

async function readBlockFullTextByRef(doc: any, ref: string): Promise<string> {
  const data = await doc.getNodeById({ id: ref });
  return extractNodeText(data);
}

export async function inspectDocumentStructure(docId: string): Promise<string> {
  //获取对应doc
  const doc = await getSession(docId);
  const tableBlocks = await doc.blocks.list({
    nodeTypes: ["table"],
    limit: 50,
  } as Record<string, unknown>);
  const tables = ((tableBlocks as Record<string, unknown>).blocks ||
    []) as Array<{ nodeId: string }>;

  if (!tables.length) {
    return JSON.stringify({
      totalTables: 0,
      tables: [],
      message: "文档中没有表格",
    });
  }

  const result: Array<{
    tableIndex: number;
    rows: number;
    cols: number;
    preview: string;
  }> = [];

  for (let i = 0; i < tables.length; i++) {
    const table: TableAddress = {
      kind: "block",
      nodeType: "table",
      nodeId: tables[i].nodeId,
    };
    const tableInfo = await doc.tables.get({ target: table });
    const rows = ((tableInfo as Record<string, unknown>).rows as number) || 0;
    const cols =
      ((tableInfo as Record<string, unknown>).columns as number) || 0;
    const cells = await getTableCells(doc, table);

    const grid: string[][] = [];
    await Promise.all(
      cells.map(async (cell) => {
        const row = cell.rowIndex;
        const col = cell.columnIndex;
        if (!grid[row]) grid[row] = [];
        //标记
        grid[row][col] = await readCellPreviewTextByRef(doc, cell.nodeId);
      }),
    );

    const previewRows: string[] = [];
    for (let r = 0; r < rows; r++) {
      const row = grid[r] || [];
      const rowCells: string[] = [];
      for (let c = 0; c < cols; c++) rowCells.push(row[c] || "");
      previewRows.push(rowCells.join(" | "));
    }

    result.push({
      tableIndex: i,
      rows,
      cols,
      preview: previewRows.join("\n"),
    });
  }

  return JSON.stringify(
    { totalTables: tables.length, tables: result },
    null,
    2,
  );
}

export async function readTableContent(
  docId: string,
  tableIndex: number = 0,
): Promise<string> {
  const doc = await getSession(docId);
  const table = await getTableByIndex(doc, tableIndex);
  if (!table) return JSON.stringify({ error: `未找到表格 #${tableIndex}` });

  const tableInfo = await doc.tables.get({ target: table });
  const rows = ((tableInfo as Record<string, unknown>).rows as number) || 0;
  const cols = ((tableInfo as Record<string, unknown>).columns as number) || 0;
  const cells = await getTableCells(doc, table);

  const result: {
    tableIndex: number;
    rows: number;
    cols: number;
    cells: TableCellInfo[];
  } = { tableIndex, rows, cols, cells: [] };

  const cellsWithText = await Promise.all(
    cells.map(async (cell) => ({
      cell,
      text: await readCellPreviewTextByRef(doc, cell.nodeId),
    })),
  );

  for (const { cell, text } of cellsWithText) {
    result.cells.push({
      row: cell.rowIndex,
      col: cell.columnIndex,
      rowspan: cell.rowspan,
      colspan: cell.colspan,
      ref: cell.nodeId,
      text,
    });
  }

  return JSON.stringify(result, null, 2);
}

export async function readTableCellText(
  docId: string,
  cellRef: string,
): Promise<string> {
  const doc = await getSession(docId);
  return readCellFullTextByRef(doc, cellRef);
}

export async function readTableStyle(
  docId: string,
  target: TableTargetInput = { tableIndex: 0 },
): Promise<string> {
  const doc = await getSession(docId);
  const table = await resolveTableTarget(doc, target);
  if (!table) return JSON.stringify({ error: "table not found", target });

  const [properties, styles] = await Promise.all([
    doc.tables.getProperties({ target: table }),
    doc.tables.getStyles({ target: table }),
  ]);

  return JSON.stringify(
    {
      target: {
        tableIndex: target.tableIndex,
        tableRef: table.nodeId,
      },
      properties,
      styles,
    },
    null,
    2,
  );
}

export async function applyTableFormat(
  docId: string,
  input: TableFormatInput,
): Promise<string> {
  const doc = await getSession(docId);
  const table = await resolveTableTarget(doc, input.target);
  if (!table) {
    return JSON.stringify({ error: "table not found", target: input.target });
  }

  const applied: string[] = [];

  if (input.layout) {
    await doc.tables.setLayout({
      target: table,
      ...input.layout,
    });
    applied.push("layout");
  }

  if (input.styleOptions) {
    await doc.tables.applyStyle({
      target: table,
      styleOptions: input.styleOptions,
    });
    applied.push("styleOptions");
  }

  if (input.borders) {
    await doc.tables.setBorders({
      target: table,
      mode: "set",
      edges: input.borders,
    });
    applied.push("borders");
  }

  if (input.shading) {
    await doc.tables.setShading({
      target: table,
      color: input.shading.fill,
    });
    applied.push("shading");
  }

  if (input.padding) {
    await doc.tables.setTablePadding({
      target: table,
      topPt: input.padding.top,
      rightPt: input.padding.right,
      bottomPt: input.padding.bottom,
      leftPt: input.padding.left,
    });
    applied.push("padding");
  }

  return JSON.stringify(
    {
      success: true,
      target: {
        tableIndex: input.target.tableIndex,
        tableRef: table.nodeId,
      },
      applied,
    },
    null,
    2,
  );
}

export async function inspectTextBlocks(
  docId: string,
  options: {
    offset?: number;
    limit?: number;
    previewLimit?: number;
    nodeTypes?: string[];
  } = {},
): Promise<string> {
  const doc = await getSession(docId);
  const offset = options.offset ?? 0;
  const limit = Math.min(options.limit ?? 50, 100);
  const previewLimit = options.previewLimit ?? CELL_PREVIEW_LIMIT;
  const nodeTypes = options.nodeTypes ?? ["paragraph"];
  const blocks = await getBlocks(doc, nodeTypes, limit, offset);

  const textBlocks: TextBlockInfo[] = await Promise.all(
    blocks.map(async (block, index) => {
      const text = await readBlockFullTextByRef(doc, block.nodeId);
      return {
        blockIndex: offset + index,
        ref: block.nodeId,
        nodeType: block.nodeType ?? block.type,
        text: text.length > previewLimit ? text.slice(0, previewLimit) : text,
      };
    }),
  );

  return JSON.stringify(
    {
      offset,
      limit,
      nodeTypes,
      count: textBlocks.length,
      blocks: textBlocks,
    },
    null,
    2,
  );
}

export async function readTextBlock(
  docId: string,
  ref: string,
): Promise<string> {
  const doc = await getSession(docId);
  const text = await readBlockFullTextByRef(doc, ref);
  return JSON.stringify({ ref, text }, null, 2);
}

export async function insertTextAfterBlock(
  docId: string,
  ref: string,
  text: string,
): Promise<string> {
  const doc = await getSession(docId);
  const target: BlockAddress = {
    kind: "block",
    nodeType: "paragraph",
    nodeId: ref,
  };
  const edge = { kind: "nodeEdge" as const, node: target, edge: "after" as const };
  await doc.insert({
    target: {
      kind: "selection",
      start: edge,
      end: edge,
    },
    content: [
      {
        type: "paragraph",
        children: [{ type: "text", text }],
      },
    ],
  });
  return JSON.stringify({ success: true, ref, text }, null, 2);
}

// 多单元格写入只是对单次 setText SDK 封装的循环包装；权限和审批逻辑放在 agentTools。
export async function writeCellsText(
  docId: string,
  cells: CellWriteInput[],
  options?: MutationApplyOptions,
): Promise<CellWriteResult[]> {
  const doc = await getSession(docId);
  const results: CellWriteResult[] = [];

  for (const cell of cells) {
    // 读取写入前的原始文本
    const beforeText = await readCellFullTextByRef(doc, cell.ref);
    try {
      await applyTextRewrite(
        doc,
        cell.ref,
        cell.text,
        `write-cell-${results.length}`,
        options,
      );

      // 读取写入后的文本，用于验证
      const afterText = await readCellFullTextByRef(doc, cell.ref);
      results.push({
        ...cell,
        success: true,
        beforeText,
        afterText,
        verified: afterText === cell.text, // 验证写入是否成功
        changeMode: options?.changeMode,
      });
    } catch (error) {
      // 写入失败，记录错误信息
      results.push({
        ...cell,
        success: false,
        beforeText,
        afterText: beforeText, // 失败时 afterText 等于 beforeText
        verified: false,
        changeMode: options?.changeMode,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  }

  return results;
}

/**
 * 【新增】验证单元格文本是否匹配
 *
 * 【核心功能】
 * 检查指定单元格的当前文本是否等于期望值。
 * 用于写入后的验证，确保写入操作真正生效。
 *
 * 【为什么需要验证】
 * - SDK 的写入操作可能静默失败（不抛出异常但未实际写入）
 * - 协作环境下可能被其他用户的编辑覆盖
 * - 验证是确保数据一致性的最后防线
 *
 * 【使用场景】
 * Agent 写入单元格后，必须调用此函数验证：
 * 1. writeCellsText 写入单元格
 * 2. verifyCells 验证写入是否成功
 * 3. 如果验证失败，Agent 应该重试或报告错误
 *
 * 【返回值说明】
 * 返回数组，每个元素包含：
 * - 原始 CellWriteInput 的所有字段（ref、text、reason）
 * - actualText: 单元格的实际文本内容
 * - matched: 是否匹配（actualText === text）
 *
 * @param docId - 文档 ID
 * @param cells - 要验证的单元格数组
 * @returns 每个单元格的验证结果
 */
export async function verifyCells(
  docId: string,
  cells: CellWriteInput[],
): Promise<Array<CellWriteInput & { actualText: string; matched: boolean }>> {
  const doc = await getSession(docId);
  return Promise.all(
    cells.map(async (cell) => {
      // 读取单元格的实际文本
      const actualText = await readCellFullTextByRef(doc, cell.ref);
      return {
        ...cell,
        actualText,
        matched: actualText === cell.text, // 比较实际文本与期望文本
      };
    }),
  );
}
