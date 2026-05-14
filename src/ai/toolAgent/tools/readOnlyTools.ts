import type { ToolDefinition } from "../toolTypes";
import { registerTool } from "../toolRegistry";
import { createExtractReferenceTemplatesTool } from "./extractReferenceTemplatesTool";
import { createInspectDocumentsTool } from "./inspectDocumentsTool";
import { createInspectSdkCellTextTool } from "./inspectSdkCellTextTool";
import { createInspectTableStructureTool } from "./inspectTableStructureTool";

export function createReadOnlyDocumentTools(): ToolDefinition[] {
  return [
    createInspectDocumentsTool(),
    createInspectTableStructureTool(),
    createInspectSdkCellTextTool(),
    createExtractReferenceTemplatesTool(),
  ];
}

export function registerReadOnlyDocumentTools(): void {
  for (const tool of createReadOnlyDocumentTools()) {
    registerTool(tool);
  }
}
