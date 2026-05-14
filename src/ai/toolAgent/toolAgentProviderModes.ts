export type ToolAgentProviderMode =
  | "static_planning_only"
  | "mock_llm"
  | "llm_planning_only";

export type ToolAgentProviderModeReason =
  | "default_static"
  | "enabled_llm_planning_only"
  | "fallback_missing_llm"
  | "fallback_non_planning_mode"
  | "fallback_mock_llm_not_allowed_in_entry"
  | "fallback_invalid_provider_mode";

export function isToolAgentProviderMode(
  value: unknown,
): value is ToolAgentProviderMode {
  return (
    value === "static_planning_only" ||
    value === "mock_llm" ||
    value === "llm_planning_only"
  );
}

export interface ResolveProviderModeInput {
  toolAgentMode?: string;
  rawToolAgentProviderMode?: unknown;
  hasLlm: boolean;
}

export function resolveToolAgentProviderModeForEntry(
  input: ResolveProviderModeInput,
): ToolAgentProviderMode {
  const requestedProviderMode = isToolAgentProviderMode(input.rawToolAgentProviderMode)
    ? input.rawToolAgentProviderMode
    : "static_planning_only";

  if (
    input.toolAgentMode === "planning_only" &&
    requestedProviderMode === "llm_planning_only" &&
    input.hasLlm
  ) {
    return "llm_planning_only";
  }

  return "static_planning_only";
}

export interface ExplainProviderModeResult {
  providerMode: ToolAgentProviderMode;
  reason: ToolAgentProviderModeReason;
}

export function explainToolAgentProviderModeForEntry(
  input: ResolveProviderModeInput,
): ExplainProviderModeResult {
  const requestedProviderMode = isToolAgentProviderMode(input.rawToolAgentProviderMode)
    ? input.rawToolAgentProviderMode
    : undefined;

  // 未传 providerMode
  if (!requestedProviderMode) {
    return { providerMode: "static_planning_only", reason: "default_static" };
  }

  // mock_llm 在真实入口不允许
  if (requestedProviderMode === "mock_llm") {
    return { providerMode: "static_planning_only", reason: "fallback_mock_llm_not_allowed_in_entry" };
  }

  // 非法值
  if (requestedProviderMode !== "llm_planning_only" && requestedProviderMode !== "static_planning_only") {
    return { providerMode: "static_planning_only", reason: "fallback_invalid_provider_mode" };
  }

  // llm_planning_only 请求
  if (requestedProviderMode === "llm_planning_only") {
    if (input.toolAgentMode !== "planning_only") {
      return { providerMode: "static_planning_only", reason: "fallback_non_planning_mode" };
    }
    if (!input.hasLlm) {
      return { providerMode: "static_planning_only", reason: "fallback_missing_llm" };
    }
    return { providerMode: "llm_planning_only", reason: "enabled_llm_planning_only" };
  }

  // static_planning_only 请求
  return { providerMode: "static_planning_only", reason: "default_static" };
}
