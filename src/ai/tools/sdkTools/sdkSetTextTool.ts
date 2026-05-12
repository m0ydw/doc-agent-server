/**
 * SDKSetTextTool — 设置指定目标格的文本内容
 *
 * 【使用的 Agent 节点】TemplateFiller（通过 editor 服务直接调用）
 * 【底层调用】editor.setText(docId, ref, text)
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKSetTextTool extends StructuredTool {
  name = "sdk_set_text";
  description = "在指定位置精确写入文本，保留原格式。需提供匹配文本的 ref 定位。适用于：填表时在空白单元格写入内容";

  static metadata: SDKToolMetadata = {
    displayName: "写入文本",
    argsFormatter: (a: Record<string, unknown>) => `写入 "${a.text}"`,
    showInUI: true,
  };

  schema = z.object({
    ref: z.string().describe("目标位置的 ref（从 sdk_get_structure 或 sdk_find_text 获取）"),
    text: z.string().describe("要写入的文本内容"),
  });

  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      return await editor.setText(this.docId, input.ref, input.text);
    } catch (err: unknown) { return `写入失败: ${(err as Error).message}`; }
  }
}
