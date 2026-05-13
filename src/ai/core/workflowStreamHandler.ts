import { ChatOpenAI } from "@langchain/openai";
import { createWorkflow } from "../workflow/graph";
import { getToolMetadataByName } from "../tools/sdkTools";
import { fileRegistry } from "../../services/fileRegistry";

type NodeOutput = Record<string, unknown> | undefined;
type SendFn = (type: string, data?: Record<string, unknown>) => void;

const NODE_LABELS: Record<string, string> = {
  orchestrator: "正在分析任务...",
  doc_analyst: "正在解析参考和目标 DOCX 表格...",
  execution_planner: "正在生成单元格级写入计划...",
  document_filler: "正在写入目标文档...",
};

export function getNodeLabel(nodeName: string): string | undefined {
  return NODE_LABELS[nodeName];
}

export async function dispatchWorkflow(
  llm: ChatOpenAI,
  userInput: string,
  docId: string,
  signal: AbortSignal,
  send: SendFn,
): Promise<void> {
  const graph = createWorkflow(llm);
  const currentDoc = fileRegistry.get(docId);

  // 推断 referenceDocId：从 fileRegistry 中找到另一个文档作为参考文档
  const docs = fileRegistry.getAll();
  const otherDoc = docs.find(d => d.docId !== docId);

  // 增强日志：记录文档推断结果
  console.log(`[Workflow] Starting workflow with:`);
  console.log(`[Workflow]   targetDoc (selected): ${currentDoc?.originalName || "unknown"} <${docId}>`);
  console.log(`[Workflow]   referenceDoc (inferred): ${otherDoc?.originalName || "unknown"} <${otherDoc?.docId || "none"}>`);

  const stream = graph.streamEvents(
    {
      userInput,
      docId,
      targetDocId: docId,
      targetDocName: currentDoc?.originalName || "",
      referenceDocId: otherDoc?.docId || "",
      referenceDocName: otherDoc?.originalName || "",
      docContext: fileRegistry.toContextString(docId),
      maxRetry: 3,
      retryCount: 0,
    },
    {
      version: "v2",
      streamMode: ["messages"] as const,
      signal,
    },
  );

  for await (const event of stream) {
    handleStreamEvent(event as unknown as Record<string, unknown>, send);
  }
}

function handleStreamEvent(event: Record<string, unknown>, send: SendFn): void {
  switch (event.event) {
    case "on_chat_model_stream":
      handleLLMToken();
      break;
    case "on_chain_start":
      handleChainStart(event, send);
      break;
    case "on_chain_end":
      handleChainEnd(event, send);
      break;
    case "on_tool_start":
      handleToolStart(event, send);
      break;
    case "on_tool_end":
      handleToolEnd(event, send);
      break;
    case "on_custom_event":
      handleCustomEvent(event, send);
      break;
  }
}

function handleLLMToken(): void {
  // 不透传内部 LLM token。结构化 JSON 必须在各节点结束后一次性解析，
  // 否则多 agent / 多 pass 的流式 token 会在 UI 日志里交错。
}

function handleChainStart(event: Record<string, unknown>, send: SendFn): void {
  const nodeName = event.name as string | undefined;
  if (!nodeName || !NODE_LABELS[nodeName]) return;

  send("phase_start", { phase: nodeName });
  send("phase_status", { text: NODE_LABELS[nodeName] });
}

function handleChainEnd(event: Record<string, unknown>, send: SendFn): void {
  const nodeName = event.name as string | undefined;
  const data = event.data as Record<string, unknown> | undefined;
  const output = data?.output as NodeOutput;
  if (!nodeName) return;

  if (output?.workflowError) {
    send("summary", {
      result: "failed",
      summary_text: output.workflowError,
      detail: output.executionLog || "",
      failed_tasks: [nodeName],
    });
  }

  switch (nodeName) {
    case "orchestrator":
      parseOrchestratorOutput(output, send);
      break;
    case "doc_analyst":
      parseDocAnalystOutput(output, send);
      break;
    case "execution_planner":
      parseExecutionPlannerOutput(output, send);
      break;
    case "document_filler":
      parseDocumentFillerOutput(output, send);
      break;
  }

  if (NODE_LABELS[nodeName]) {
    send("phase_end", { phase: nodeName });
  }
}

function parseOrchestratorOutput(output: NodeOutput, send: SendFn): void {
  if (!output?.analysis) return;

  try {
    const analysis = JSON.parse(output.analysis as string) as {
      intent?: string;
      agentPlan?: unknown[];
      resolvedDocs?: { referenceDocName?: string; targetDocName?: string };
    };
    const ref = analysis.resolvedDocs?.referenceDocName;
    const target = analysis.resolvedDocs?.targetDocName;
    const suffix = ref && target ? `，参考文档：${ref}，目标文档：${target}` : "";
    send("content", {
      content: `任务分析完成：${analysis.intent || "未命名任务"}，共 ${analysis.agentPlan?.length || 0} 个步骤${suffix}`,
    });
  } catch (err) {
    console.warn("[WorkflowStream] failed to parse orchestrator output:", (err as Error).message);
  }
}

function parseDocAnalystOutput(output: NodeOutput, send: SendFn): void {
  if (output?.tableAnalysisId) {
    send("content", {
      content: `参考/目标表格分析完成：analysis=${output.tableAnalysisId}`,
    });
    return;
  }

  if (output?.semanticSchemaId) {
    send("content", {
      content: `文档结构分析完成：schema=${output.semanticSchemaId}`,
    });
  }
}

function parseExecutionPlannerOutput(output: NodeOutput, send: SendFn): void {
  if (!output?.executionPlan) return;

  try {
    const plan = JSON.parse(output.executionPlan as string) as {
      fillPlans?: unknown[];
      metadata?: {
        highConfidenceCount?: number;
        mappedCount?: number;
        lowConfidenceCount?: number;
        failedReasons?: string[];
      };
    };
    send("content", {
      content: `执行计划完成：${plan.fillPlans?.length || 0} 个写入动作，${plan.metadata?.highConfidenceCount || 0} 个高置信匹配，${plan.metadata?.mappedCount || 0} 个已映射`,
    });
  } catch (err) {
    console.warn("[WorkflowStream] failed to parse execution planner output:", (err as Error).message);
  }
}

function parseDocumentFillerOutput(output: NodeOutput, send: SendFn): void {
  if (output?.success === undefined || !output?.transaction) return;

  try {
    const transaction = JSON.parse(output.transaction as string) as {
      writes?: Array<{ success: boolean; ref: string; value: string; error?: string }>;
    };
    const writes = transaction.writes || [];
    const successCount = writes.filter(write => write.success).length;

    for (const write of writes) {
      send("tool_result", {
        success: write.success,
        tool: "写入文档",
        result: write.success ? `${write.ref}: ${write.value}` : `${write.ref}: ${write.error || "写入失败"}`,
      });
    }

    send("summary", {
      result: output.success ? "success" : "failed",
      summary_text: output.success ? `写入完成：${successCount}/${writes.length}` : `写入失败：${successCount}/${writes.length}`,
      detail: JSON.stringify(writes),
      failed_tasks: writes.filter(write => !write.success).map(write => write.ref),
    });
  } catch (err) {
    console.warn("[WorkflowStream] failed to parse document filler output:", (err as Error).message);
  }
}

function handleToolStart(event: Record<string, unknown>, send: SendFn): void {
  const toolName = (event.name as string) || "";
  const toolInput = (event.data as Record<string, unknown>)?.input;
  const meta = getToolMetadataByName(toolName);
  if (!meta?.showInUI) return;

  send("tool_start", {
    tool: meta.displayName,
    args: meta.argsFormatter((toolInput as Record<string, unknown>) || {}),
  });
}

function handleToolEnd(event: Record<string, unknown>, send: SendFn): void {
  const toolName = (event.name as string) || "";
  const output = (event.data as Record<string, unknown>)?.output;
  const meta = getToolMetadataByName(toolName);
  if (!meta?.showInUI) return;

  send("tool_result", {
    success: true,
    tool: meta.displayName,
    result: typeof output === "string" ? output : JSON.stringify(output || ""),
  });
}

function handleCustomEvent(event: Record<string, unknown>, send: SendFn): void {
  const custom = event.data as Record<string, unknown> | undefined;
  if (custom?.type) {
    send(custom.type as string, custom.data as Record<string, unknown>);
  }
}
