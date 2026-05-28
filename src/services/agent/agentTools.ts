import { jsonSchema, tool } from "ai";
import {
  chooseTools,
  dispatchSuperDocTool,
  getSystemPrompt as getSuperDocSystemPrompt,
  getToolCatalog,
} from "@superdoc-dev/sdk";
import { z } from "zod";
import * as editor from "../editor";
import * as sessionManager from "../session";
import { createBlankDocument } from "../docServices";
import { registerDocument } from "../fileRegistry";
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
import {
  getPendingStyleVerification,
  recordToolFinished,
  shouldAllowFullTextRead,
} from "./agentToolPolicy";

type EmitAgentEvent = (
  type: AgentEvent["type"],
  payload: Record<string, unknown>,
) => void;

type ToolResult = {
  status: "ok" | "blocked" | "pending_approval" | "error";
  summary: string;
  detail?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type SuperDocVercelTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type SuperDocCatalogTool = {
  toolName: string;
  mutates: boolean;
};

type SuperDocIntentToolResources = {
  prompt: string;
  tools: SuperDocVercelTool[];
  catalogByName: Map<string, SuperDocCatalogTool>;
};

let superDocIntentToolResources: Promise<SuperDocIntentToolResources> | null =
  null;

function getSuperDocIntentToolResources(): Promise<SuperDocIntentToolResources> {
  superDocIntentToolResources ??= Promise.all([
    chooseTools({ provider: "vercel" }),
    getToolCatalog(),
    getSuperDocSystemPrompt(),
  ]).then(([selected, catalog, prompt]) => ({
    prompt,
    tools: (selected.tools as SuperDocVercelTool[]).filter(
      (item) => item?.type === "function" && item.function?.name,
    ),
    catalogByName: new Map(
      catalog.tools.map((item) => [item.toolName, item as SuperDocCatalogTool]),
    ),
  }));
  return superDocIntentToolResources;
}

const finalAnswerSchema = z.object({});

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
        .enum(["fixedWidth", "fitContents", "fitWindow"])
        .describe("Only use fixedWidth, fitContents, or fitWindow.")
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

const underlineSchema = z.union([
  z.boolean(),
  z.object({
    style: z.string().optional(),
    color: z.string().optional(),
    themeColor: z.string().optional(),
  }),
]);

const inlineTextStyleSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: underlineSchema.optional(),
  strike: z.boolean().optional(),
  color: z.string().optional().describe("Text color, for example 000000 or #000000."),
  highlight: z.string().optional().describe("Highlight color."),
  fontSize: z.number().optional().describe("Font size in points."),
  fontFamily: z.string().optional(),
  shading: z
    .object({
      fill: z.string().optional(),
      color: z.string().optional(),
      val: z.string().optional(),
    })
    .optional(),
});

const paragraphTextStyleSchema = z.object({
  alignment: z.enum(["left", "center", "right", "justify"]).optional(),
  indentation: z
    .object({
      left: z.number().optional(),
      right: z.number().optional(),
      firstLine: z.number().optional(),
      hanging: z.number().optional(),
    })
    .optional(),
  spacing: z
    .object({
      before: z.number().optional(),
      after: z.number().optional(),
      line: z.number().optional(),
      lineRule: z.string().optional(),
    })
    .optional(),
  shading: z
    .object({
      fill: z.string().optional(),
      color: z.string().optional(),
      pattern: z.string().optional(),
    })
    .optional(),
});

const textTargetSchema = z.object({
  documentName: z.string().optional(),
  pattern: z.string().min(1).describe("Text to search before styling."),
  mode: z.enum(["contains", "regex"]).optional(),
  caseSensitive: z.boolean().optional(),
  nodeId: z.string().optional().describe("Optional block nodeId to narrow the match."),
  nodeType: z.string().optional().describe("Optional node type for scoped matching, for example tableCell or paragraph."),
  blockId: z.string().optional().describe("Optional blockId returned by find_text_targets."),
  ref: z.string().optional().describe("Optional search ref returned by find_text_targets."),
  withinNodeId: z.string().optional().describe("Optional container nodeId used with doc.query.match within."),
  withinNodeType: z.string().optional().describe("Optional container nodeType used with within, for example tableCell."),
  matchIndex: z.number().int().min(0).optional().describe("0-based index after filters; default 0."),
  all: z.boolean().optional().describe("true applies to every filtered match."),
});

const textStyleSchema = textTargetSchema.extend({
  inline: inlineTextStyleSchema.optional(),
  paragraph: paragraphTextStyleSchema.optional(),
  paragraphStyleId: z.string().optional(),
  styleScope: z
    .enum(["match", "block", "container"])
    .default("block")
    .optional()
    .describe(
      "Inline style scope. Use block by default; use match only for the exact matched text; use container for all text blocks inside a table cell/container.",
    ),
});

const createDocumentSchema = z.object({
  documentName: z
    .string()
    .optional()
    .describe("New DOCX name. .docx is appended if missing."),
  title: z.string().optional(),
  paragraphs: z.array(z.string()).optional(),
});

const getTextSchema = z.object({
  documentName: z.string().optional(),
  purpose: z
    .enum([
      "explicit_full_document_request",
      "targeted_tools_insufficient",
      "final_integrity_check",
    ])
    .describe(
      "Required. Full text is expensive: use explicit_full_document_request only when the user asked for full-document reading, targeted_tools_insufficient after low-token tools were tried, or final_integrity_check after edits.",
    ),
  reason: z
    .string()
    .min(8)
    .describe(
      "Required. Explain why low-token tools such as find_text, inspect_text_blocks, read_text_block, or inspect_document_tables are insufficient.",
    ),
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

function buildSuperDocToolSchema(schema: Record<string, unknown>) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return {
    ...(schema as Record<string, unknown>),
    properties: {
      documentName: {
        type: "string",
        description:
          "Optional document name or id. Omit to use the active document.",
      },
      ...properties,
    },
  };
}

function stripAgentOnlyArgs(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const { documentName: _documentName, ...args } = input;
  return args;
}

function withPermissionModeArgs(
  args: Record<string, unknown>,
  permissionMode: AgentRun["permissionMode"],
): Record<string, unknown> {
  if (permissionMode !== "auto_tracked") return args;
  if ("changeMode" in args) return args;
  return { ...args, changeMode: "tracked" };
}

function documentNameFromArgs(input: unknown): string | undefined {
  return isRecord(input) && typeof input.documentName === "string"
    ? input.documentName
    : undefined;
}

function styleVerificationQueryFromInput(input: unknown): Record<string, unknown> {
  const source = isRecord(input) ? input : {};
  const styleSource = isRecord(source.styleInput) ? source.styleInput : source;
  const {
    inline: _inline,
    paragraph: _paragraph,
    paragraphStyleId: _paragraphStyleId,
    styleScope: _styleScope,
    permissionMode: _permissionMode,
    ...query
  } = styleSource;
  return query;
}

async function withToolEvents<T extends ToolResult>(
  emit: EmitAgentEvent,
  name: string,
  input: unknown,
  run: () => Promise<T>,
  policyRun?: AgentRun,
): Promise<T> {
  // ========== 调试日志：工具调用开始 ==========
  logToolCall(name);
  logToolInput(input);

  emit("tool.started", { name, input });
  try {
    const result = await run();
    if (name === "apply_text_style" && result.status === "ok") {
      result.detail = {
        result: result.detail,
        needsStyleVerification: true,
        verificationTool: "read_text_style",
        documentName: documentNameFromArgs(input),
        verificationQuery: styleVerificationQueryFromInput(input),
        verificationInstruction:
          "Call read_text_style with verificationQuery before finalAnswer. If coverage is partial, retry apply_text_style with a broader styleScope.",
      };
    }

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
      input,
    });
    if (policyRun) {
      recordToolFinished(policyRun, name, input, result.status);
    }
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
      input,
    });
    if (policyRun) {
      recordToolFinished(policyRun, name, input, result.status);
    }
    return result as T;
  }
}

function createSuperDocIntentTools(
  run: AgentRun,
  emit: EmitAgentEvent,
  resources: SuperDocIntentToolResources,
) {
  return Object.fromEntries(
    resources.tools.map((superDocTool) => {
      const toolName = superDocTool.function.name;
      const catalogEntry = resources.catalogByName.get(toolName);
      const mutates = Boolean(catalogEntry?.mutates);

      return [
        toolName,
        tool({
          description: superDocTool.function.description,
          inputSchema: jsonSchema(
            buildSuperDocToolSchema(superDocTool.function.parameters),
          ),
          execute: async (input) =>
            withToolEvents(emit, toolName, input, async () => {
              const documentName = documentNameFromArgs(input);
              const targetDoc = requireDocument(run, documentName);

              if (mutates && run.permissionMode === "read_only") {
                return {
                  status: "blocked",
                  summary: "read_only 模式下不能执行会修改文档的 SuperDoc 工具。",
                  detail: { toolName, input },
                };
              }

              const { doc } = await sessionManager.createOrUseSession(
                targetDoc.id,
              );
              const result = await dispatchSuperDocTool(
                doc,
                toolName,
                withPermissionModeArgs(
                  stripAgentOnlyArgs(input),
                  run.permissionMode,
                ),
              );

              return {
                status: "ok",
                summary: `${toolName} completed. ${toSummaryText(result)}`,
                detail: result,
              };
            }),
        }),
      ];
    }),
  );
}

export async function getSuperDocAgentSystemPrompt(): Promise<string> {
  const resources = await getSuperDocIntentToolResources();
  return resources.prompt;
}

export async function createAgentTools(run: AgentRun, emit: EmitAgentEvent) {
  const superDocResources = await getSuperDocIntentToolResources();

  return {
    ...createSuperDocIntentTools(run, emit, superDocResources),
    finalAnswer: tool({
      description:
        "Call this exactly once when all required tool work is complete. Do not call while style verification is pending. This is only a signal; do not include the final answer here. After this tool returns, write the final answer as normal text.",
      inputSchema: finalAnswerSchema,
      execute: async () =>
        withToolEvents(emit, "finalAnswer", {}, async () => {
          const pendingStyleVerification = getPendingStyleVerification(run);
          if (pendingStyleVerification) {
            return {
              status: "blocked",
              summary:
                "样式写入后仍需验证。请先按 detail.verificationQuery 调用 read_text_style，确认 block/runs 覆盖范围后再结束。",
              detail: {
                verificationQuery: pendingStyleVerification.query,
                documentName: pendingStyleVerification.documentName,
              },
            };
          }
          return {
            status: "ok",
            summary: "Ready for final text response.",
          };
        }, run),
    }),

    create_document: tool({
      description:
        "新建一个 DOCX，并注册到当前系统；成功后前端会自动打开。可给 documentName/title/paragraphs。",
      inputSchema: createDocumentSchema,
      execute: async ({ documentName, title, paragraphs }) =>
        withToolEvents(
          emit,
          "create_document",
          { documentName, title, paragraphCount: paragraphs?.length ?? 0 },
          async () => {
            const metadata = await createBlankDocument({
              originalName: documentName,
              title,
              paragraphs,
            });
            registerDocument(metadata);
            run.documents.forEach((doc) => {
              doc.active = false;
            });
            run.documents.push({
              id: metadata.id,
              name: metadata.originalName,
              active: true,
            });
            run.activeDocId = metadata.id;

            return {
              status: "ok",
              summary: `已新建文档《${metadata.originalName}》。`,
              detail: {
                document: {
                  id: metadata.id,
                  name: metadata.originalName,
                  originalName: metadata.originalName,
                  size: metadata.size,
                  uploadedAt: metadata.uploadedAt,
                },
              },
            };
          },
        ),
    }),
    get_text: tool({
      description: [
        "High token / last resort. Reads the full DOCX plain text.",
        "Use when: the user explicitly asks for full-document reading, summary, overall review, or targeted tools have already proven insufficient.",
        "Do not use when: starting a task, locating text, changing styles, editing tables, or checking a small region.",
        "Prefer first: find_text, inspect_text_blocks, read_text_block, inspect_document_tables.",
        "Requires purpose and reason; policy blocks unjustified full-document reads.",
      ].join(" "),
      inputSchema: getTextSchema,
      execute: async ({ documentName, purpose, reason }) =>
        withToolEvents(
          emit,
          "get_text",
          { documentName, purpose, reason },
          async () => {
            const policy = shouldAllowFullTextRead(run, { purpose, reason });
            if (!policy.allowed) {
              return {
                status: "blocked",
                summary: policy.summary ?? "get_text blocked by policy.",
                detail: policy.detail,
              };
            }
            const doc = requireDocument(run, documentName);
            const text = await editor.getText(doc.id);
            return {
              status: "ok",
              summary: `Read full text from ${doc.name}; length ${text.length} characters.`,
              detail: { text },
            };
          },
          run,
        ),
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
        "读取一个表格的 properties/styles。用 target.tableIndex 或 target.tableRef 定位。只读。",
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
        "设置一个表格格式。autoFitMode 只能是 fixedWidth、fitContents、fitWindow。边框用 top/bottom/left/right/insideH/insideV。",
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
        "低 token 扫描段落/text block，返回 ref、length、短预览。插入到末尾时用 offset=length。",
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
        "按 inspect_text_blocks 返回的 ref 读取完整文本，并返回 length。",
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

    find_text_targets: tool({
      description:
        "搜索文本并返回可用于设置样式的候选目标。用 nodeId/blockId/ref 缩小到表格单元格内文本或某段文本。",
      inputSchema: textTargetSchema,
      execute: async ({ documentName, ...query }) =>
        withToolEvents(
          emit,
          "find_text_targets",
          { documentName, query },
          async () => {
            const doc = requireDocument(run, documentName);
            const result = parseJsonResult(
              await editor.findTextTargets(doc.id, query),
            );
            return {
              status: "ok",
              summary: `已在 ${doc.name} 中定位文本样式目标：${toSummaryText(result)}`,
              detail: result,
            };
          },
        ),
    }),

    read_text_style: tool({
      description:
        "读取文本/段落样式。先按 pattern 搜索，可用 nodeId/blockId/ref/matchIndex/all 精确筛选；返回 node attrs、paragraphStyle、runs 常见格式，方便格式刷。",
      inputSchema: textTargetSchema,
      execute: async ({ documentName, ...query }) =>
        withToolEvents(
          emit,
          "read_text_style",
          { documentName, query },
          async () => {
            const doc = requireDocument(run, documentName);
            const result = parseJsonResult(
              await editor.readTextStyle(doc.id, query),
            );
            return {
              status: "ok",
              summary: `已读取 ${doc.name} 的文本样式：${toSummaryText(result)}`,
              detail: result,
            };
          },
        ),
    }),

    apply_text_style: tool({
      description:
        "先按 pattern 搜索，再用 nodeId/blockId/ref/matchIndex/all 精确筛选，设置文字/段落样式。只应用传入的样式字段；段落样式必须有 paragraph/heading/listItem nodeId。",
      inputSchema: textStyleSchema,
      execute: async ({ documentName, ...styleInput }) =>
        withToolEvents(
          emit,
          "apply_text_style",
          { documentName, styleInput, permissionMode: run.permissionMode },
          async () => {
            const doc = requireDocument(run, documentName);
            if (run.permissionMode === "read_only") {
              return {
                status: "blocked",
                summary: "当前是 read_only 模式，不能修改文本样式。",
                detail: styleInput,
              };
            }

            const hasInline = Boolean(
              styleInput.inline && Object.keys(styleInput.inline).length,
            );
            const hasParagraph = Boolean(
              styleInput.paragraph && Object.keys(styleInput.paragraph).length,
            );
            if (!hasInline && !hasParagraph && !styleInput.paragraphStyleId) {
              return {
                status: "blocked",
                summary: "没有传入任何样式字段，未修改文档。",
                detail: styleInput,
              };
            }

            const result = parseJsonResult(
              await editor.applyTextStyle(
                doc.id,
                styleInput,
                mutationOptionsForPermission(run.permissionMode),
              ),
            );
            return {
              status: "ok",
              summary: `已设置 ${doc.name} 的文本样式：${toSummaryText(result)}`,
              detail: result,
            };
          },
        ),
    }),

    insert_text_at_block_offset: tool({
      description:
        "在 text block 内按字符 offset 插入纯文本。ref 来自 inspect_text_blocks；追加到末尾用 offset=length。",
      inputSchema: z.object({
        documentName: z.string().optional(),
        ref: z.string().min(1),
        offset: z.number().int().min(0),
        text: z.string(),
      }),
      execute: async ({ documentName, ref, offset, text }) =>
        withToolEvents(
          emit,
          "insert_text_at_block_offset",
          { documentName, ref, offset, text, permissionMode: run.permissionMode },
          async () => {
            const doc = requireDocument(run, documentName);
            if (run.permissionMode === "read_only") {
              return {
                status: "blocked",
                summary: "当前是 read_only 模式，不能插入文本。",
                detail: { ref, offset, text },
              };
            }

            const result = parseJsonResult(
              await editor.insertTextAtBlockOffset(doc.id, ref, offset, text),
            );
            return {
              status: "ok",
              summary: `已在 ${doc.name} 的文本块 offset=${offset} 插入文本。`,
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
