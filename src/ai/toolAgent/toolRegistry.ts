import type { ToolDefinition } from "./toolTypes";

const toolRegistry = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  if (toolRegistry.has(tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }

  toolRegistry.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

export function listTools(): readonly ToolDefinition[] {
  return Array.from(toolRegistry.values());
}

export function clearToolsForTest(): void {
  toolRegistry.clear();
}
