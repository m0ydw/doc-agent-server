import type { ToolDefinition } from "../toolTypes";
import { registerTool } from "../toolRegistry";
import { createWriteDocxTool } from "./writeDocxTool";

export function createWritingTools(): ToolDefinition[] {
  return [
    createWriteDocxTool(),
  ];
}

export function registerWritingTools(): void {
  for (const tool of createWritingTools()) {
    registerTool(tool);
  }
}
