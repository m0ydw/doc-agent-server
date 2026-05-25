import { tool } from "ai";
import { z } from "zod";
import * as editor from "../editor";
import {
  addPendingApproval,
  waitForApprovalResult,
} from "./agentSessionManager";
import type {
  AgentCellWrite,
  AgentEvent,
  AgentRun,
  ApprovalItem,
} from "./agentTypes";
import {
  logToolCall,
  logToolInput,
  logToolOutput,
  logToolError,
} from "./agentLogger";

type EmitAgentEvent = (
  type: AgentEvent["type"],
  payload: Record<string, unknown>,
) => void;

type ToolResult = {
  status: "ok" | "blocked" | "pending_approval" | "error";
  summary: string;
  detail?: unknown;
};

function mutationOptionsForPermission(permissionMode: AgentRun["permissionMode"]) {
  return permissionMode === "auto_tracked"
    ? ({ changeMode: "tracked" } as const)
    : undefined;
}

const cellWriteSchema = z.object({
  documentName: z
    .string()
    .optional()
    .describe("目标文档名称；不填则使用当前文档"),
  ref: z.string().min(1).describe("表格单元格 ref / nodeId"),
  text: z.string().describe("要写入该单元格的新文本"),
  reason: z.string().optional().describe("为什么要写入这个值"),
  tableIndex: z.number().optional(),
  row: z.number().optional(),
  col: z.number().optional(),
});

const replaceTextSchema = z.object({
  documentName: z
    .string()
    .optional()
    .describe("目标文档名称；不填则使用当前文档"),
  targetText: z.string().min(1).describe("要查找并替换的原文本"),
  replacement: z.string().describe("替换后的新文本"),
  replaceAll: z.boolean().default(true).describe("true 替换全部匹配；false 只替换第一处"),
  reason: z.string().optional().describe("为什么要做这次替换"),
});

const tableTargetSchema = z.object({
  tableIndex: z.number().optional(),
  tableRef: z.string().optional(),
});

const tableBorderSchema = z.object({
  lineStyle: z.string().optional(),
  lineWeightPt: z.number().optional(),
  color: z.string().optional(),
});

const tableFormatSchema = z.object({
  documentName: z.string().optional(),
  target: tableTargetSchema.default({ tableIndex: 0 }),
  layout: z
    .object({
      alignment: z.enum(["left", "center", "right"]).optional(),
      autoFitMode: z
        .enum(["fixedWidth", "autoFit", "autoFitWindow"])
        .optional(),
      preferredWidth: z.number().optional(),
    })
    .optional(),
  styleOptions: z
    .object({
      headerRow: z.boolean().optional(),
      lastRow: z.boolean().optional(),
      firstColumn: z.boolean().optional(),
      lastColumn: z.boolean().optional(),
      bandedRows: z.boolean().optional(),
      bandedColumns: z.boolean().optional(),
    })
    .optional(),
  borders: z
    .object({
      top: tableBorderSchema.optional(),
      bottom: tableBorderSchema.optional(),
      left: tableBorderSchema.optional(),
      right: tableBorderSchema.optional(),
      insideH: tableBorderSchema.optional(),
      insideV: tableBorderSchema.optional(),
    })
    .optional(),
  shading: z
    .object({
      fill: z.string(),
    })
    .optional(),
  padding: z
    .object({
      top: z.number(),
      bottom: z.number(),
      left: z.number(),
      right: z.number(),
    })
    .optional(),
});

function parseJsonResult(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toSummaryText(value: unknown, maxLength = 220): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function resolveDocument(run: AgentRun, documentName?: string) {
  if (!documentName) {
    return (
      run.documents.find((doc) => doc.id === run.activeDocId) ??
      run.documents[0]
    );
  }

  const normalized = documentName.trim().toLowerCase();
  return (
    run.documents.find((doc) => doc.name.trim().toLowerCase() === normalized) ??
    run.documents.find((doc) =>
      doc.name.trim().toLowerCase().includes(normalized),
    ) ??
    run.documents.find((doc) => doc.id === documentName)
  );
}

function requireDocument(run: AgentRun, documentName?: string) {
  const doc = resolveDocument(run, documentName);
  if (!doc) {
    throw new Error(`未找到可操作文档：${documentName || "当前文档"}`);
  }
  return doc;
}

async function withToolEvents<T extends ToolResult>(
  emit: EmitAgentEvent,
  name: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  // ========== 调试日志：工具调用开始 ==========
  logToolCall(name);
  logToolInput(input);

  emit("tool.started", { name, input });
  try {
    const result = await run();

    // ========== 调试日志：工具返回值 ==========
    logToolOutput({
      status: result.status,
      summary: result.summary,
      detail: result.detail,
    });

    emit("tool.finished", {
      name,
      status: result.status,
      summary: result.summary,
      detail: result.detail,
    });
    return result;
  } catch (error) {
    // ========== 调试日志：工具错误 ==========
    logToolError(name, error);

    const result = {
      status: "error" as const,
      summary: error instanceof Error ? error.message : "工具调用失败",
      detail: { error },
    };
    emit("tool.finished", {
      name,
      status: result.status,
      summary: result.summary,
      detail: result.detail,
    });
    return result as T;
  }
}

export function createAgentTools(run: AgentRun, emit: EmitAgentEvent) {
  return {
    get_text: tool({
      description:
        "读取某个 DOCX 文档全文。documentName 不填时读取当前文档。",
      inputSchema: z.object({
        documentName: z.string().optional(),
      }),
      execute: async ({ documentName }) =>
        withToolEvents(emit, "get_text", { documentName }, async () => {
          const doc = requireDocument(run, documentName);
          const text = await editor.getText(doc.id);
          return {
            status: "ok",
            summary: `已读取《${doc.name}》全文，长度 ${text.length} 字符。`,
            detail: { text },
          };
        }),
    }),

    find_text: tool({
      description:
        "在某个 DOCX 文档中查找文本。documentName 不填时查找当前文档。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        pattern: z.string().min(1).describe("要查找的文本"),
      }),
      execute: async ({ documentName, pattern }) =>
        withToolEvents(emit, "find_text", { documentName, pattern }, async () => {
          const doc = requireDocument(run, documentName);
          const matches = await editor.findText(doc.id, pattern);
          return {
            status: "ok",
            summary: `在《${doc.name}》中找到 ${matches.length} 处“${pattern}”。`,
            detail: { documentName: doc.name, pattern, count: matches.length, matches },
          };
        }),
    }),

    replace_text: tool({
      description:
        "查找并替换 DOCX 文本。会根据权限模式阻塞、发起审批、以修订模式替换或直接替换。替换前会先查找匹配项。",
      inputSchema: replaceTextSchema,
      execute: async ({ documentName, targetText, replacement, replaceAll, reason }, options) =>
        withToolEvents(
          emit,
          "replace_text",
          { documentName, targetText, replacement, replaceAll, permissionMode: run.permissionMode },
          async () => {
            const doc = requireDocument(run, documentName);
            if (run.permissionMode === "read_only") {
              return {
                status: "blocked",
                summary: "当前权限是 read_only，替换已被阻止。",
                detail: { targetText, replacement },
              };
            }

            const allMatches = await editor.findText(doc.id, targetText);
            const matches = replaceAll ? allMatches : allMatches.slice(0, 1);
            if (!matches.length) {
              return {
                status: "ok",
                summary: `未在《${doc.name}》中找到“${targetText}”，没有修改文档。`,
                detail: { documentName: doc.name, targetText, replacement, count: 0, matches: [] },
              };
            }

            if (run.permissionMode === "review_required") {
              const items: ApprovalItem[] = matches.map((match, index) => ({
                operation: "text_replace",
                documentName: doc.name,
                itemId: `${options.toolCallId}-${index}`,
                ref: match.ref,
                text: replacement,
                oldText: match.text || targetText,
                newText: replacement,
                reason,
              }));
              const approval = addPendingApproval(
                run.runId,
                items,
                options.toolCallId,
              );
              emit("approval.requested", {
                approvalId: approval.approvalId,
                items: approval.items,
              });
              const resolution = await waitForApprovalResult(approval.approvalId);
              return {
                status: "ok",
                summary: `替换审批已处理：批准 ${resolution.approvedCount} 项，拒绝 ${resolution.rejectedCount} 项。`,
                detail: resolution,
              };
            }

            const replaceResult = await editor.replaceByRefs(
              doc.id,
              matches.map((match) => ({
                ref: match.ref,
                oldText: match.text || targetText,
                text: replacement,
                reason,
              })),
              mutationOptionsForPermission(run.permissionMode),
            );
            const successful = replaceResult.filter((item) => item.success).length;
            const modeText =
              run.permissionMode === "auto_tracked" ? "以修订模式" : "直接";
            return {
              status: "ok",
              summary: `已在《${doc.name}》${modeText}替换 ${successful} 处“${targetText}”。`,
              detail: {
                documentName: doc.name,
                targetText,
                replacement,
                changeMode:
                  run.permissionMode === "auto_tracked" ? "tracked" : "default",
                replaceResult,
              },
            };
          },
        ),
    }),

    inspect_document_tables: tool({
      description:
        "读取某个 DOCX 中所有表格概览。返回每个表格的行列数和短文本预览。",
      inputSchema: z.object({
        documentName: z.string().optional(),
      }),
      execute: async ({ documentName }) =>
        withToolEvents(emit, "inspect_document_tables", { documentName }, async () => {
          const doc = requireDocument(run, documentName);
          const result = parseJsonResult(
            await editor.inspectDocumentStructure(doc.id),
          );
          return {
            status: "ok",
            summary: `已读取《${doc.name}》所有表格概览：${toSummaryText(result)}`,
            detail: result,
          };
        }),
    }),

    inspect_table_structure: tool({
      description:
        "读取指定表格结构和每个单元格的短文本。tableIndex 从 0 开始。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        tableIndex: z.number().default(0),
      }),
      execute: async ({ documentName, tableIndex }) =>
        withToolEvents(
          emit,
          "inspect_table_structure",
          { documentName, tableIndex },
          async () => {
            const doc = requireDocument(run, documentName);
            const result = parseJsonResult(
              await editor.readTableContent(doc.id, tableIndex),
            );
            return {
              status: "ok",
              summary: `已读取《${doc.name}》表格 #${tableIndex}：${toSummaryText(result)}`,
              detail: result,
            };
          },
        ),
    }),

    read_cell_text: tool({
      description: "读取某个表格单元格的完整文本，不做 20 字限制。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        ref: z.string().min(1),
      }),
      execute: async ({ documentName, ref }) =>
        withToolEvents(emit, "read_cell_text", { documentName, ref }, async () => {
          const doc = requireDocument(run, documentName);
          const text = await editor.readTableCellText(doc.id, ref);
          return {
            status: "ok",
            summary: `已读取《${doc.name}》目标单元格，长度 ${text.length} 字符。`,
            detail: { ref, text },
          };
        }),
    }),

    read_table_style: tool({
      description:
        "读取 DOCX 表格的属性和可用样式。先用 tableIndex 或 tableRef 定位表格，再返回 properties/styles，适合做样式诊断或格式刷前的取样。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        target: tableTargetSchema.default({ tableIndex: 0 }),
      }),
      execute: async ({ documentName, target }) =>
        withToolEvents(
          emit,
          "read_table_style",
          { documentName, target },
          async () => {
            const doc = requireDocument(run, documentName);
            const result = parseJsonResult(
              await editor.readTableStyle(doc.id, target),
            );
            return {
              status: "ok",
              summary: `已读取 ${doc.name} 的表格样式：${toSummaryText(result)}`,
              detail: result,
            };
          },
        ),
    }),

    apply_table_format: tool({
      description:
        "设置 DOCX 表格格式。支持布局、样式选项、边框、底纹、单元格内边距；这是写操作，read_only 模式会阻止执行。",
      inputSchema: tableFormatSchema,
      execute: async ({ documentName, ...formatInput }) =>
        withToolEvents(
          emit,
          "apply_table_format",
          { documentName, formatInput, permissionMode: run.permissionMode },
          async () => {
            const doc = requireDocument(run, documentName);
            if (run.permissionMode === "read_only") {
              return {
                status: "blocked",
                summary: "当前是 read_only 模式，不能修改表格格式。",
                detail: formatInput,
              };
            }

            const result = parseJsonResult(
              await editor.applyTableFormat(doc.id, formatInput),
            );
            return {
              status: "ok",
              summary: `已设置 ${doc.name} 的表格格式：${toSummaryText(result)}`,
              detail: result,
            };
          },
        ),
    }),

    inspect_text_blocks: tool({
      description:
        "低 token 扫描 DOCX 段落/text block，返回 blockIndex、ref 和短预览。需要段落 ref 做插入或精确读取时，先调用这个工具。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        offset: z.number().default(0),
        limit: z.number().default(50),
        previewLimit: z.number().default(20),
        nodeTypes: z.array(z.string()).optional(),
      }),
      execute: async ({ documentName, offset, limit, previewLimit, nodeTypes }) =>
        withToolEvents(
          emit,
          "inspect_text_blocks",
          { documentName, offset, limit, previewLimit, nodeTypes },
          async () => {
            const doc = requireDocument(run, documentName);
            const result = parseJsonResult(
              await editor.inspectTextBlocks(doc.id, {
                offset,
                limit,
                previewLimit,
                nodeTypes,
              }),
            );
            return {
              status: "ok",
              summary: `已扫描 ${doc.name} 的文本块：${toSummaryText(result)}`,
              detail: result,
            };
          },
        ),
    }),

    read_text_block: tool({
      description:
        "按段落/text block ref 读取完整文本。ref 通常来自 inspect_text_blocks。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        ref: z.string().min(1),
      }),
      execute: async ({ documentName, ref }) =>
        withToolEvents(emit, "read_text_block", { documentName, ref }, async () => {
          const doc = requireDocument(run, documentName);
          const result = parseJsonResult(await editor.readTextBlock(doc.id, ref));
          return {
            status: "ok",
            summary: `已读取 ${doc.name} 的文本块：${toSummaryText(result)}`,
            detail: result,
          };
        }),
    }),

    insert_text_after_block: tool({
      description:
        "在指定段落/text block 后插入新段落。ref 必须来自 inspect_text_blocks/read_text_block。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        ref: z.string().min(1),
        text: z.string(),
      }),
      execute: async ({ documentName, ref, text }) =>
        withToolEvents(
          emit,
          "insert_text_after_block",
          { documentName, ref, text, permissionMode: run.permissionMode },
          async () => {
            const doc = requireDocument(run, documentName);
            if (run.permissionMode === "read_only") {
              return {
                status: "blocked",
                summary: "当前是 read_only 模式，不能插入文本。",
                detail: { ref, text },
              };
            }

            const result = parseJsonResult(
              await editor.insertTextAfterBlock(doc.id, ref, text),
            );
            return {
              status: "ok",
              summary: `已在 ${doc.name} 的文本块后插入段落。`,
              detail: result,
            };
          },
        ),
    }),

    dry_run_write_cells: tool({
      description:
        "预演批量写入单元格，不真正修改 DOCX。写入前优先调用这个工具生成计划。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        cells: z.array(cellWriteSchema).min(1),
      }),
      execute: async ({ documentName, cells }) =>
        withToolEvents(
          emit,
          "dry_run_write_cells",
          { documentName, cells },
          async () => {
            const doc = requireDocument(run, documentName);
            const detail = await Promise.all(
              cells.map(async (cell: AgentCellWrite) => ({
                ...cell,
                documentName: cell.documentName ?? doc.name,
                oldText: await editor.readTableCellText(
                  requireDocument(run, cell.documentName ?? doc.name).id,
                  cell.ref,
                ),
                newText: cell.text,
              })),
            );
            return {
              status: "ok",
              summary: `已预演 ${detail.length} 个单元格写入，未修改文档。`,
              detail,
            };
          },
        ),
    }),

    write_cells_text: tool({
      description:
        "批量写入单元格。会根据权限模式阻塞、发起审批、以修订模式写入或直接写入。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        cells: z.array(cellWriteSchema).min(1),
      }),
      execute: async ({ documentName, cells }, options) =>
        withToolEvents(
          emit,
          "write_cells_text",
          { documentName, cells, permissionMode: run.permissionMode },
          async () => {
            const doc = requireDocument(run, documentName);
            if (run.permissionMode === "read_only") {
              return {
                status: "blocked",
                summary: "当前权限是 read_only，写入已被阻止。",
                detail: { cells },
              };
            }

            if (run.permissionMode === "review_required") {
              const items: ApprovalItem[] = await Promise.all(
                cells.map(async (cell: AgentCellWrite, index: number) => ({
                  ...cell,
                  operation: "cell_write" as const,
                  documentName: cell.documentName ?? doc.name,
                  itemId: `${options.toolCallId}-${index}`,
                  oldText: await editor.readTableCellText(
                    requireDocument(run, cell.documentName ?? doc.name).id,
                    cell.ref,
                  ),
                  newText: cell.text,
                })),
              );
              const approval = addPendingApproval(
                run.runId,
                items,
                options.toolCallId,
              );
              emit("approval.requested", {
                approvalId: approval.approvalId,
                items: approval.items,
              });
              const resolution = await waitForApprovalResult(approval.approvalId);
              return {
                status: "ok",
                summary: `写入审批已处理：批准 ${resolution.approvedCount} 项，拒绝 ${resolution.rejectedCount} 项。`,
                detail: resolution,
              };
            }

            const mutationOptions = mutationOptionsForPermission(run.permissionMode);
            const writeResult = await editor.writeCellsText(
              doc.id,
              cells,
              mutationOptions,
            );
            const successCount = writeResult.filter((item) => item.success).length;
            if (run.permissionMode === "auto_tracked") {
              return {
                status: writeResult.every((item) => item.success) ? "ok" : "error",
                summary: `已以修订模式写入 ${successCount} 个单元格，等待前端审阅 UI 接受或拒绝。`,
                detail: {
                  changeMode: "tracked",
                  writeResult,
                },
              };
            }

            const verifyResult = await editor.verifyCells(doc.id, cells);
            return {
              status: "ok",
              summary: `已直接写入 ${writeResult.length} 个单元格，验证匹配 ${verifyResult.filter((item) => item.matched).length} 个。`,
              detail: { writeResult, verifyResult },
            };
          },
        ),
    }),

    verify_cells: tool({
      description: "验证单元格文本是否等于期望值。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        cells: z.array(cellWriteSchema).min(1),
      }),
      execute: async ({ documentName, cells }) =>
        withToolEvents(emit, "verify_cells", { documentName, cells }, async () => {
          const doc = requireDocument(run, documentName);
          const result = await editor.verifyCells(doc.id, cells);
          return {
            status: "ok",
            summary: `已验证 ${result.length} 个单元格，匹配 ${result.filter((item) => item.matched).length} 个。`,
            detail: result,
          };
        }),
    }),
  };
}
