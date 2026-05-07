import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { SDKToolMetadata } from "./sdkToolTypes";

export class SDKTaskCompleteTool extends StructuredTool {
  name = "task_complete";
  description = "★★★ 所有任务执行完成后必须调用此工具！调用后执行将立即结束。";
  static metadata: SDKToolMetadata = {
    displayName: "执行完成",
    argsFormatter: () => "任务执行完毕",
    showInUI: false,
  };
  schema = z.object({ summary: z.string().optional().describe("执行结果的简要总结") });
  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    return `执行完成${input.summary ? "：" + input.summary : ""}`;
  }
}
