import type { ToolDefinition } from "../toolTypes";
import { registerTool } from "../toolRegistry";
import { createVerifyDocxTool } from "./verifyDocxTool";

export function createVerificationTools(): ToolDefinition[] {
  return [
    createVerifyDocxTool(),
  ];
}

export function registerVerificationTools(): void {
  for (const tool of createVerificationTools()) {
    registerTool(tool);
  }
}
