import { tool } from "ai";
import { z } from "zod";
import * as editor from "../editor";
import {
  addPendingApproval,
} from "./agentSessionManager";
import type {
  AgentCellWrite,
  AgentEvent,
  AgentRun,
  ApprovalItem,
} from "./agentTypes";

type EmitAgentEvent = (
  type: AgentEvent["type"],
  payload: Record<string, unknown>,
) => void;

type ToolResult = {
  status: "ok" | "blocked" | "pending_approval" | "error";
  summary: string;
  detail?: unknown;
};

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
  emit("tool.started", { name, input });
  try {
    const result = await run();
    emit("tool.finished", {
      name,
      status: result.status,
      summary: result.summary,
      detail: result.detail,
    });
    return result;
  } catch (error) {
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
        "批量写入单元格。会根据权限模式阻塞、发起审批、以修订尝试写入或直接写入。",
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
              return {
                status: "pending_approval",
                summary: `已生成 ${items.length} 个待审阅写入项，等待用户批准或拒绝。`,
                detail: approval,
              };
            }

            if (run.permissionMode === "auto_tracked") {
              const result = await editor.writeCellsTextTracked(
                doc.id,
                cells,
              );
              return {
                status: result.success ? "ok" : "error",
                summary: result.message,
                detail: result,
              } as ToolResult;
            }

            const writeResult = await editor.writeCellsText(doc.id, cells);
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
