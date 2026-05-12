/**
 * summaryBuilder — 对话式中文摘要生成器
 *
 * 从 wsAgentHandler.ts 迁出，纯文本处理逻辑，不依赖 WebSocket。
 *
 * 【设计目的】
 * Agent 各阶段完成后，需要向前端发送一句简洁的中文摘要，
 * 告知用户 Agent 做了什么、结果如何。而不是直接展示原始 JSON 数据。
 *
 * 【调用时机】
 * 1. buildAnalysisSummary → orchestrator 分析完成时
 * 2. buildPlanSummary     → plan 阶段完成时
 * 3. buildValidateSummary → reviewer 验证完成时
 * 4. extractTodoList      → 生成前端任务清单时
 *
 * 【输入/输出】
 * 每个函数接收 JSON 字符串，返回中文摘要文本，失败时返回 null。
 */

/**
 * 从 analysis JSON 构建分析阶段中文摘要
 *
 * 根据 intent 类型和 operations 列表生成自然语言描述。
 * - content_query 类型 → "先了解一下..." 的表达
 * - 有操作列表 → 列出每个操作的目标和描述
 * - 多文档时有文档标注，单文档时简洁输出
 *
 * @param analysisJson orchestrator 输出的 analysis JSON 字符串
 * @returns 中文摘要文本，解析或构建失败返回 null
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
    const items: Array<{ goal: string; doc: string }> = ops.map((o: Record<string, unknown>) => {
      const target = (o.target as string) || (o.target_document as string) || "";
      const goal = (o.goal as string) || "";
      const doc = (o.target_document as string) || "";
      if (target && goal) return { goal: `${goal.includes(target) ? "" : "把「" + target + "」" + goal}`, doc };
      return { goal: goal || target || "", doc };
    }).filter((i) => i.goal);
    if (items.length === 0) return null;
    // 多文档时每行标注目标文档，单文档简洁输出
    if (items.every((i) => !i.doc)) return `我需要${items.map((i) => i.goal).join("，然后")}。`;
    return `任务概览：\n${items.map((i) => (i.doc ? `  • ${i.doc}：${i.goal}` : `  • ${i.goal}`)).join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * 从 plan JSON 构建执行计划中文摘要
 *
 * 提取 tasks 数组中的 goal 字段，按编号列出执行步骤。
 *
 * @param planJson plan 节点输出的 plan JSON 字符串
 * @returns 带编号的执行步骤文本
 */
function buildPlanSummary(planJson: string): string | null {
  try {
    const data = JSON.parse(planJson) as Record<string, unknown>;
    const tasks = (data.tasks as Record<string, unknown>[]) || [];
    if (tasks.length === 0) return null;
    const goals: string[] = tasks.map((t: Record<string, unknown>) => (t.goal || "") as string).filter(Boolean);
    if (goals.length === 0) return null;
    return `执行步骤：\n${goals.map((g: string, i: number) => `${i + 1}) ${g}`).join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * 从 validate JSON 构建验证结果中文摘要
 *
 * 根据 result 字段映射为中文描述：
 * - "成功" → 所有操作完成
 * - "部分成功" → 部分操作完成
 * - "失败" → 操作未完成
 *
 * @param validateJson reviewer 输出的验证 JSON 字符串
 * @returns 验证结果的中文描述
 */
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

/**
 * 从 plan JSON 提取前端任务清单（Todo List）
 *
 * 过滤掉"保存/储存/存储"等无关任务，只保留真正的编辑操作。
 * 用于前端 Todo 进度条展示。
 *
 * @param planJson 执行计划 JSON
 * @returns 前端 Todo List 组件所需的 { id, goal } 数组
 */
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
