import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../../services/editor";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKGetStructureTool extends StructuredTool {
  name = "sdk_get_structure";
  description = "提取文档结构（表格/段落位置及 ref 索引）。填表前必须调用以定位可填充字段";

  static metadata: SDKToolMetadata = {
    displayName: "提取结构",
    argsFormatter: () => "获取文档结构",
    showInUI: true,
  };

  schema = z.object({});

  private docId: string;
  constructor(docId: string) { super(); this.docId = docId; }

  async _call(_input: z.infer<typeof this.schema>): Promise<string> {
    try {
      return await editor.getStructure(this.docId);
    } catch (err: unknown) { return `结构提取失败: ${(err as Error).message}`; }
  }
}
