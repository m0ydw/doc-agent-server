/**
 * SDKReadTableTool — 读取文档中指定表格的完整结构
 *
 * 【使用的 Agent 节点】DocAnalyst（主用）、Reviewer（验证）
 * 【底层调用】editor.readTable(docId, tableIndex)
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKReadTableTool extends StructuredTool {
  name = "sdk_read_table";
  description = "★★★【填表核心工具】读取文档中指定表格的结构化地图，返回 JSON（含每格的行列坐标、合并跨度和写入 ref，不含文本）。填表第一步：先调用此工具获取坐标地图，再通过 sdk_find_text 确认标签所在的 row/col，最后用 sdk_set_text(ref) 写入目标格。";
  static metadata: SDKToolMetadata = {
    displayName: "读取表格",
    argsFormatter: (a: Record<string, unknown>) => `读取表格[${a.tableIndex || 0}]`,
    showInUI: true,
  };
  schema = z.object({ tableIndex: z.number().optional().default(0).describe("表格索引，从 0 开始") });
  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }
  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try { return await editor.readTable(this.docId, input.tableIndex); }
    catch (err: unknown) { return JSON.stringify({ error: (err as Error).message }); }
  }
}
