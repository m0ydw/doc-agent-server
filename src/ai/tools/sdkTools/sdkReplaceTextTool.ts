/**
 * SDKReplaceTextTool — 替换文档中第一个匹配的文本
 *
 * 【使用的 Agent 节点】SurgicalEditor
 * 【底层调用】editor.replaceFirst(docId, target, replacement)
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKReplaceTextTool extends StructuredTool {
  name = "sdk_replace_text";
  description = "替换文档中第一个匹配的文本。适用于：逐处替换、精确替换指定位置";
  static metadata: SDKToolMetadata = {
    displayName: "替换文本",
    argsFormatter: (a: Record<string, unknown>) => `将 "${a.target}" 替换为 "${a.replacement}"`,
    showInUI: true,
  };
  schema = z.object({ target: z.string().describe("要被替换的旧文本"), replacement: z.string().describe("替换后的新文本") });
  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }
  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const result = await editor.replaceFirst(this.docId, input.target, input.replacement);
      if (result.success) return `成功替换: "${input.target}" → "${input.replacement}"（替换了 ${result.replaced} 处）`;
      return `替换失败: ${result.message || `未找到"${input.target}"`}`;
    } catch (err: unknown) { return `替换异常: ${(err as Error).message}`; }
  }
}
