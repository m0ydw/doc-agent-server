import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKReplaceAllTool extends StructuredTool {
  name = "sdk_replace_all";
  description = "替换文档中所有匹配的文本。适用于：全文替换、批量修改";
  static metadata: SDKToolMetadata = {
    displayName: "批量替换",
    argsFormatter: (a: Record<string, unknown>) => `将所有 "${a.target}" 替换为 "${a.replacement}"`,
    showInUI: true,
  };
  schema = z.object({ target: z.string().describe("要被替换的旧文本"), replacement: z.string().describe("替换后的新文本") });
  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }
  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const result = await editor.replaceAll(this.docId, input.target, input.replacement);
      if (result.success) return `成功全文替换: "${input.target}" → "${input.replacement}"（共替换 ${result.replaced} 处）`;
      return `全文替换失败: ${result.message}`;
    } catch (err: unknown) { return `全文替换异常: ${(err as Error).message}`; }
  }
}
