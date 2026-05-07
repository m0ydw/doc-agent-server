import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKApplyFormatTool extends StructuredTool {
  name = "sdk_apply_format";
  description = "对指定文本应用格式（加粗/斜体/下划线/删除线）。用户说'名字加粗'或'电话用下划线'时使用此工具";

  static metadata: SDKToolMetadata = {
    displayName: "应用格式",
    argsFormatter: (a: Record<string, unknown>) => `格式: ${(a.bold ? "加粗 " : "")}${(a.italic ? "斜体 " : "")}`,
    showInUI: true,
  };

  schema = z.object({
    pattern: z.string().describe("要应用格式的文本（如姓名、电话）"),
    bold: z.enum(["on", "off"]).optional().describe("加粗"),
    italic: z.enum(["on", "off"]).optional().describe("斜体"),
    underline: z.enum(["on", "off"]).optional().describe("下划线"),
    strike: z.enum(["on", "off"]).optional().describe("删除线"),
  });

  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const format: Record<string, "on" | "off"> = {};
      if (input.bold) format.bold = input.bold;
      if (input.italic) format.italic = input.italic;
      if (input.underline) format.underline = input.underline;
      if (input.strike) format.strike = input.strike;
      return await editor.applyFormat(this.docId, input.pattern, format);
    } catch (err: unknown) { return `格式应用失败: ${(err as Error).message}`; }
  }
}
