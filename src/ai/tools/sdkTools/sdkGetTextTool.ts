/**
 * SDKGetTextTool — 获取文档纯文本内容
 *
 * 【使用的 Agent 节点】Reviewer（用于读取验证）、GlobalAgent Chat 模式
 * 【底层调用】editor.getText(docId)
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKGetTextTool extends StructuredTool {
  name = "sdk_get_text";
  description = "★★★【核心工具】读取文档的纯文本全文。当你需要理解文档内容、进行总结/分析/提取信息/翻译/回答问题时，必须先调用此工具获取文档内容！返回文档的全部文字。";
  static metadata: SDKToolMetadata = {
    displayName: "读取文档",
    argsFormatter: () => "获取文档全文",
    showInUI: true,
  };
  schema = z.object({});
  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }
  async _call(_input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const text = await editor.getText(this.docId);
      if (!text || text.length === 0) return "文档内容为空";
      console.log("[GET_TEXT] 全文(" + text.length + "字符):\n" + text);
      return text;
    } catch (err: unknown) { return `读取文档失败: ${(err as Error).message}`; }
  }
}
