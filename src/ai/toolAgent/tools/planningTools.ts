import type { ToolDefinition } from "../toolTypes";
import { registerTool } from "../toolRegistry";
import { createDryRunFillPlanTool } from "./dryRunFillPlanTool";
import { createGenerateFillPlanTool } from "./generateFillPlanTool";

export function createPlanningTools(): ToolDefinition[] {
  return [
    createGenerateFillPlanTool(),
    createDryRunFillPlanTool(),
  ];
}

export function registerPlanningTools(): void {
  for (const tool of createPlanningTools()) {
    registerTool(tool);
  }
}
