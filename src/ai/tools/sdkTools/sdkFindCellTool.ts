/**
 * SDKFindCellTool — 在表格中查找包含指定文本的单元格
 *
 * 【使用的 Agent 节点】DocAnalyst（标签定位）、Reviewer（验证）
 * 【底层调用】editor.findCell(docId, text)
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKFindCellTool extends StructuredTool {
  name = "sdk_find_cell";
  description = "在表格中查找包含指定文本的单元格，返回 ref 和位置索引。填表时用于定位字段（如找到'姓名'单元格后，可写入其右侧单元格）";
  static metadata: SDKToolMetadata = {
    displayName: "查找单元格",
    argsFormatter: (a: Record<string, unknown>) => `找 "${a.pattern}" 所在的单元格`,
    showInUI: true,
  };
  schema = z.object({ pattern: z.string().describe("单元格中要查找的文本（如姓名、电话）") });
  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }
  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      return await editor.findCell(this.docId, input.pattern);
    } catch (err: unknown) { return `查找单元格失败: ${(err as Error).message}`; }
  }
}
