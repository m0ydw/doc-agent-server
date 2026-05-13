import { ChatOpenAI } from "@langchain/openai";
import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { AgentState } from "../../state";
import { extractStructuredData } from "../../../modules/dataExtractor";
import { KNOWN_FIELDS } from "../../../modules/fieldConfig";
import { fileRegistry, type DocRegistryEntry } from "../../../../services/fileRegistry";

interface AgentDelegation {
  agent: string;
  input?: Record<string, unknown>;
  dependsOn?: number;
}

interface OrchestratorOutput {
  intent: string;
  taskType: "simple_edit" | "complex_fill" | "query" | "format_change" | "mixed";
  agentPlan: AgentDelegation[];
}

interface ResolvedDocIds {
  referenceDocId: string;
  targetDocId: string;
  referenceDocName: string;
  targetDocName: string;
  missingReason?: string;
}

const OrchestratorOutputSchema = z.object({
  intent: z.string(),
  taskType: z.enum(["simple_edit", "complex_fill", "query", "format_change", "mixed"]),
  agentPlan: z.array(z.object({
    agent: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    dependsOn: z.number().optional(),
  })),
});

const SYSTEM_PROMPT = `你是 DOCX 多 agent 工作流的任务规划器。只输出合法 JSON。

可用 agent：
- doc_analyst：解析参考 DOCX 和目标 DOCX 的表格结构
- execution_planner：根据参考文档的位置模板生成 nodeId/ref 级写入计划
- document_filler：只执行明确写入计划

复杂填表任务必须使用 doc_analyst -> execution_planner -> document_filler。
不要输出“需用户提供”这类占位符。`;

export function createOrchestratorNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, _config?: RunnableConfig): Promise<Partial<typeof AgentState.State>> => {
    const logs: string[] = [];
    let output: OrchestratorOutput | null = null;
    let extractedDataStr = state.extractedData;
    const runId = `run_${Date.now()}`;

    try {
      logs.push(formatStepLog(runId, "orchestrator", "start", "", { docId: state.docId }, "success", null));

      output = await classifyTask(llm, state);
      logs.push(formatStepLog(runId, "orchestrator", "classification", JSON.stringify(output), output, "success", null));

      if (output.taskType === "complex_fill") {
        const resolved = resolveDocIds(state);
        if (!resolved.referenceDocId || !resolved.targetDocId) {
          const error = resolved.missingReason || "复杂 DOCX 填表任务缺少 referenceDocId 或 targetDocId。";
          logs.push(formatStepLog(runId, "orchestrator", "doc_id_validation", "", resolved, "failed", error));
          return {
            analysis: JSON.stringify({ ...output, resolvedDocs: resolved, error }),
            planJson: JSON.stringify({ agentPlan: [] }),
            referenceDocId: resolved.referenceDocId,
            targetDocId: resolved.targetDocId,
            extractedData: extractedDataStr,
            needsUserInput: true,
            workflowError: error,
            executionLog: logs.join("\n"),
            delegationStep: 0,
            lastAgent: "Orchestrator",
            success: false,
          };
        }

        const extractResult = await extractStructuredData(llm, state.userInput, KNOWN_FIELDS);
        extractedDataStr = JSON.stringify(extractResult.data);
        logs.push(formatStepLog(
          runId,
          "orchestrator",
          "data_extraction",
          "",
          { fieldCount: Object.keys(extractResult.data).length, method: extractResult.method, coverage: extractResult.coverage },
          "success",
          null,
        ));

        return {
          analysis: JSON.stringify({ ...output, resolvedDocs: resolved }),
          planJson: JSON.stringify({ agentPlan: output.agentPlan }),
          referenceDocId: resolved.referenceDocId,
          targetDocId: resolved.targetDocId,
          docId: resolved.targetDocId,
          targetDocName: resolved.targetDocName,
          extractedData: extractedDataStr,
          needsUserInput: false,
          workflowError: "",
          executionLog: logs.join("\n"),
          delegationStep: 0,
          lastAgent: "Orchestrator",
          success: true,
        };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      output = fallbackClassification(state.userInput);
      logs.push(formatStepLog(runId, "orchestrator", "fallback", "", output, "failed", error));
    }

    return {
      analysis: JSON.stringify(output),
      planJson: JSON.stringify({ agentPlan: output?.agentPlan || [] }),
      extractedData: extractedDataStr,
      executionLog: logs.join("\n"),
      delegationStep: 0,
      lastAgent: "Orchestrator",
      success: true,
    };
  };
}

async function classifyTask(llm: ChatOpenAI, state: typeof AgentState.State): Promise<OrchestratorOutput> {
  const response = await llm.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(`用户需求：${state.userInput}

当前文档上下文：
${state.docContext || fileRegistry.toContextString(state.docId)}

当前选中文档：${state.targetDocName || state.docId || "未指定"}

请输出 JSON。`),
  ]);

  const content = typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallbackClassification(state.userInput);

  const parsed = JSON.parse(jsonMatch[0]);
  const validated = OrchestratorOutputSchema.safeParse(parsed);
  if (!validated.success) return fallbackClassification(state.userInput);

  const plan = sanitizePlan(validated.data);
  return plan.agentPlan.length > 0 ? plan : fallbackClassification(state.userInput);
}

function sanitizePlan(output: OrchestratorOutput): OrchestratorOutput {
  if (output.taskType !== "complex_fill") return output;

  return {
    ...output,
    agentPlan: [
      { agent: "doc_analyst" },
      { agent: "execution_planner", dependsOn: 0 },
      { agent: "document_filler", dependsOn: 1 },
    ],
  };
}

function fallbackClassification(userInput: string): OrchestratorOutput {
  if (/填表|填入|填充|根据.*参考|空白.*表|docx/i.test(userInput)) {
    return {
      intent: "根据参考 DOCX 表格填充目标空白 DOCX",
      taskType: "complex_fill",
      agentPlan: [
        { agent: "doc_analyst" },
        { agent: "execution_planner", dependsOn: 0 },
        { agent: "document_filler", dependsOn: 1 },
      ],
    };
  }

  if (/替换|改成|换成/.test(userInput)) {
    return {
      intent: "文本替换",
      taskType: "simple_edit",
      agentPlan: [{ agent: "doc_analyst" }],
    };
  }

  return {
    intent: "文档分析",
    taskType: "query",
    agentPlan: [{ agent: "doc_analyst" }],
  };
}

function resolveDocIds(state: typeof AgentState.State): ResolvedDocIds {
  const docs = fileRegistry.getAll();
  const selected = findValidDoc(state.docId, docs);
  const target = findValidDoc(state.targetDocId, docs)
    || (selected && looksLikeTarget(selected) ? selected : undefined)
    || findMentionedDoc(docs, state.userInput, ["空白", "blank", "模板", "target"])
    || findByNameHint(docs, ["空白", "blank", "模板", "target"])
    || selected;
  const reference = findValidDoc(state.referenceDocId, docs)
    || findMentionedDoc(docs.filter(doc => doc.docId !== target?.docId), state.userInput, ["参考", "已填", "样例", "示例", "with", "filled", "与绘"])
    || findByNameHint(docs.filter(doc => doc.docId !== target?.docId), ["参考", "已填", "样例", "示例", "with", "filled", "与绘"])
    || docs.find(doc => doc.docId !== target?.docId);

  const missing: string[] = [];
  if (!reference) missing.push("referenceDocId");
  if (!target) missing.push("targetDocId");
  if (reference && target && reference.docId === target.docId) {
    missing.push("referenceDocId 和 targetDocId 不能是同一个文档");
  }

  return {
    referenceDocId: reference?.docId || "",
    targetDocId: target?.docId || "",
    referenceDocName: reference?.originalName || "",
    targetDocName: target?.originalName || "",
    missingReason: missing.length > 0 ? `无法进入填表流程：${missing.join("、")} 未正确解析。请同时提供已填参考文档和空白目标文档。` : undefined,
  };
}

function findValidDoc(docId: string | undefined, docs: DocRegistryEntry[]): DocRegistryEntry | undefined {
  if (!docId || isPlaceholder(docId)) return undefined;
  return docs.find(doc => doc.docId === docId);
}

function findByNameHint(docs: DocRegistryEntry[], hints: string[]): DocRegistryEntry | undefined {
  return docs.find(doc => hints.some(hint => doc.originalName.toLowerCase().includes(hint.toLowerCase())));
}

function looksLikeTarget(doc: DocRegistryEntry): boolean {
  return /空白|blank|模板|target/i.test(doc.originalName);
}

function findMentionedDoc(docs: DocRegistryEntry[], input: string, hints: string[]): DocRegistryEntry | undefined {
  return docs.find(doc => {
    const name = doc.originalName.toLowerCase();
    const mentionedById = input.includes(doc.docId);
    const mentionedByName = input.includes(doc.originalName) || stripExt(input).includes(stripExt(doc.originalName));
    const hasHint = hints.some(hint => name.includes(hint.toLowerCase()) || input.includes(hint));
    return (mentionedById || mentionedByName) && hasHint;
  });
}

function stripExt(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}

function isPlaceholder(value: string): boolean {
  return /需用户提供|待提供|占位|placeholder|your[_-]?/.test(value);
}

function formatStepLog(
  runId: string,
  agent: string,
  step: string,
  rawOutput: string,
  parsedOutput: unknown,
  status: "success" | "failed",
  error: string | null,
): string {
  return JSON.stringify({
    runId,
    agent,
    step,
    rawOutput,
    parsedOutput,
    status,
    error,
    timestamp: new Date().toISOString(),
  });
}
