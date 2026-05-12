/**
 * SDKFindTextTool — 在文档中查找指定文本
 *
 * 【使用的 Agent 节点】SurgicalEditor（轻量文本编辑）
 * 【底层调用】editor.findText(docId, pattern)
 * 【返回】匹配的数量和位置
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKFindTextTool extends StructuredTool {
  name = "sdk_find_text";
  description = "在文档中查找指定文本，返回匹配的位置和数量。适用于：查找目标是否存、确认替换结果、定位文本";
  static metadata: SDKToolMetadata = {
    displayName: "搜索文本",
    argsFormatter: (a: Record<string, unknown>) => `搜索 "${a.pattern}"`,
    showInUI: true,
  };
  schema = z.object({ pattern: z.string().describe("要查找的文本内容（区分大小写）") });
  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }
  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const matches = await editor.findText(this.docId, input.pattern);
      if (matches.length === 0) return `未找到匹配"${input.pattern}"`;
      return `找到 ${matches.length} 处匹配"${input.pattern}"`;
    } catch (err: unknown) { return `查找失败: ${(err as Error).message}`; }
  }
}
