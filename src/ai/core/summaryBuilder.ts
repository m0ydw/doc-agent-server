/**
 * summaryBuilder — 对话式中文摘要生成器
 *
 * 从 wsAgentHandler.ts 迁出，纯文本处理逻辑，不依赖 WebSocket。
 */

function buildAnalysisSummary(analysisJson: string): string | null {
  try {
    const data = JSON.parse(analysisJson) as Record<string, unknown>;
    const intent = data.intent as string || "";
    const ops = (data.operations as Record<string, unknown>[]) || [];
    if (intent === "content_query" || (ops.length > 0 && ops[0]?.type === "query")) {
      return `我先了解一下文档中关于「${ops[0]?.target || "相关内容"}」的信息。`;
    }
    if (ops.length === 0) return null;
    const goals: string[] = ops.map((o: Record<string, unknown>) => {
      const target = (o.target as string) || "";
      const goal = (o.goal as string) || "";
      // target + goal 同时存在时拼接完整描述，例如："把「与绘」替换为七色"
      if (target && goal) return `${goal.includes(target) ? "" : "把「" + target + "」"}${goal}`;
      return goal || target || "";
    }).filter(Boolean);
    if (goals.length === 0) return null;
    return `我需要${goals.join("，然后")}。`;
  } catch {
    return null;
  }
}

function buildPlanSummary(planJson: string): string | null {
  try {
    const data = JSON.parse(planJson) as Record<string, unknown>;
    const tasks = (data.tasks as Record<string, unknown>[]) || [];
    if (tasks.length === 0) return null;
    const goals: string[] = tasks.map((t: Record<string, unknown>) => (t.goal || "") as string).filter(Boolean);
    if (goals.length === 0) return null;
    return `执行步骤：${goals.map((g: string, i: number) => `${i + 1}) ${g}`).join("；")}。`;
  } catch {
    return null;
  }
}

function buildValidateSummary(validateJson: string): string | null {
  try {
    const data = JSON.parse(validateJson) as Record<string, unknown>;
    const result = data.result as string || "";
    if (result === "成功") return "所有操作已完成，文档已保存。";
    if (result === "部分成功") return "部分操作已完成，部分未能执行。";
    if (result === "失败") return "操作未能完成。";
    return (data.summary as string) || null;
  } catch {
    return null;
  }
}

function extractTodoList(planJson: string): Array<{ id: string; goal: string }> {
  try {
    const data = JSON.parse(planJson) as Record<string, unknown>;
    const tasks = (data.tasks as Record<string, unknown>[]) || [];
    return tasks
      .filter((t: Record<string, unknown>) => !["保存", "储存", "存储"].some((k) => (t.goal as string || "").includes(k)))
      .map((t: Record<string, unknown>) => ({ id: (t.id || t.goal || "") as string, goal: (t.goal || t.description || "") as string }));
  } catch {
    return [];
  }
}

export { buildAnalysisSummary, buildPlanSummary, buildValidateSummary, extractTodoList };
