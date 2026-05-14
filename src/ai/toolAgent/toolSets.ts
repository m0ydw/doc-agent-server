import type { ToolDefinition } from "./toolTypes";
import { registerTool } from "./toolRegistry";
import { createPlanningTools } from "./tools/planningTools";
import { createReadOnlyDocumentTools } from "./tools/readOnlyTools";
import { createVerificationTools } from "./tools/verificationTools";

export function createSafeToolSet(): ToolDefinition[] {
  return [
    ...createReadOnlyDocumentTools(),
    ...createPlanningTools(),
    ...createVerificationTools(),
  ];
}

export function registerSafeToolSet(): void {
  for (const tool of createSafeToolSet()) {
    registerTool(tool);
  }
}

export function createPlanningOnlyToolSet(): ToolDefinition[] {
  return [
    ...createPlanningTools(),
    ...createVerificationTools(),
  ];
}

export function registerPlanningOnlyToolSet(): void {
  for (const tool of createPlanningOnlyToolSet()) {
    registerTool(tool);
  }
}
