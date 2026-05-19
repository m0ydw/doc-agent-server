import * as sessionManager from "../../services/session";

async function getSession(docId: string) {
  const result = await sessionManager.createOrUseSession(docId);
  return result.doc;
}
//根据ref写入text
export async function setText(
  docId: string,
  ref: string,
  text: string,
): Promise<string> {
  const doc = await getSession(docId);
  await doc.mutations.apply({
    atomic: true,
    steps: [
      {
        id: "set-text",
        op: "text.rewrite",
        where: { by: "ref", ref },
        args: {
          replacement: { text },
          style: { inline: { mode: "preserve" } },
        },
      },
    ],
  });
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
  return extractNodeText(await doc.getNodeById({ id: ref }));
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

/**
 * 【新增】批量写入单元格文本
 * 
 * 【核心功能】
 * 将多个单元格的文本内容批量写入文档，每个单元格独立处理，互不影响。
 * 即使某个单元格写入失败，其他单元格仍然会继续写入。
 * 
 * 【SDK 调用详解】
 * doc.mutations.apply 是 SuperDoc SDK 的核心写入方法：
 * 
 * 参数说明：
 * - atomic: true 表示原子操作，所有步骤要么全部成功，要么全部失败
 * - steps: 操作步骤数组，每个步骤包含：
 *   - id: 步骤唯一标识（用于日志和调试）
 *   - op: 操作类型，"text.rewrite" 表示文本替换
 *   - where: 定位目标，by: "ref" 表示通过 ref 定位单元格
 *   - args: 操作参数：
 *     - replacement.text: 新文本内容
 *     - style.inline.mode: "preserve" 表示保留原有格式（如加粗、斜体等）
 * 
 * 【执行流程】
 * 对于每个单元格：
 * 1. 读取原始文本（beforeText）
 * 2. 执行写入操作
 * 3. 读取写入后的文本（afterText）
 * 4. 验证写入是否成功（afterText === text）
 * 5. 记录结果
 * 
 * 【错误处理】
 * 使用 try-catch 包裹每个单元格的写入操作：
 * - 成功: success=true, 记录 beforeText/afterText/verified
 * - 失败: success=false, 保留 beforeText, afterText=beforeText, 记录 error
 * 
 * @param docId - 文档 ID
 * @param cells - 要写入的单元格数组
 * @returns 每个单元格的写入结果
 */
export async function writeCellsText(
  docId: string,
  cells: CellWriteInput[],
): Promise<CellWriteResult[]> {
  const doc = await getSession(docId);
  const results: CellWriteResult[] = [];

  for (const cell of cells) {
    // 读取写入前的原始文本
    const beforeText = await readCellFullTextByRef(doc, cell.ref);
    try {
      // 调用 SDK 执行写入操作
      await doc.mutations.apply({
        atomic: true,  // 原子操作：所有步骤要么全部成功，要么全部失败
        steps: [
          {
            id: `write-cell-${results.length}`,  // 步骤 ID，用于日志
            op: "text.rewrite",  // 操作类型：文本替换
            where: { by: "ref", ref: cell.ref },  // 定位：通过 ref 定位单元格
            args: {
              replacement: { text: cell.text },  // 新文本内容
              style: { inline: { mode: "preserve" } },  // 保留原有格式
            },
          },
        ],
      });

      // 读取写入后的文本，用于验证
      const afterText = await readCellFullTextByRef(doc, cell.ref);
      results.push({
        ...cell,
        success: true,
        beforeText,
        afterText,
        verified: afterText === cell.text,  // 验证写入是否成功
      });
    } catch (error) {
      // 写入失败，记录错误信息
      results.push({
        ...cell,
        success: false,
        beforeText,
        afterText: beforeText,  // 失败时 afterText 等于 beforeText
        verified: false,
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
        matched: actualText === cell.text,  // 比较实际文本与期望文本
      };
    }),
  );
}

/**
 * 【新增】以修订模式写入单元格（预留接口）
 * 
 * 【设计目的】
 * 实现"修订模式"写入，即写入时保留修改痕迹，类似于 Word 的"修订"功能。
 * 用户可以看到"原文"和"修改后"的对比，并决定是否接受修改。
 * 
 * 【预期实现方式】
 * 使用 SuperDoc SDK 的 diff.apply 方法：
 * - diff: 包含修改内容的差异对象
 * - changeMode: "tracked" 表示以修订模式应用
 * 
 * 【当前状态】
 * 暂未找到当前 SDK 版本的 diff.apply 等价调用，因此返回失败。
 * 后续需要：
 * 1. 查阅 SuperDoc SDK 文档，找到修订模式的 API
 * 2. 实现 diff 对象的构建（包含原文、新文、位置等）
 * 3. 调用 SDK 应用修订
 * 
 * 【权限模式对应】
 * - auto_apply: 直接写入（writeCellsText）
 * - auto_tracked: 修订模式写入（本函数）
 * - review_required: 需要用户审批后才写入
 * - read_only: 只读，不允许写入
 * 
 * @param docId - 文档 ID
 * @param cells - 要写入的单元格数组
 * @returns 当前总是返回失败，待后续实现
 */
export async function writeCellsTextTracked(
  _docId: string,
  _cells: CellWriteInput[],
): Promise<{ success: false; message: string }> {
  // TODO: 实现修订模式写入
  // 需要查阅 SuperDoc SDK 文档，找到 diff.apply 或等价 API
  return {
    success: false,
    message:
      "auto_tracked 暂未找到当前 SDK 文档句柄上的 diff.apply 等价调用，已阻止直接写入。",
  };
}
