/**
 * ================================================================
 * 记忆管理模块 — LangChain BaseMemory 子类
 * ================================================================
 *
 * 【设计说明】
 * DocAgentMemory 继承自 LangChain 的 BaseMemory，实现了标准化的
 * loadMemoryVariables() / saveContext() / clear() 接口。
 *
 * 同时保留了旧版 retrieveMemory() / manageMemory() 等便捷函数，
 * 通过内部单例调用，确保现有调用代码无需修改。
 *
 * 【BaseMemory 接口映射】
 *   loadMemoryVariables({ docPath, userInput })
 *     → 检索与该文档+用户输入相关的历史执行记录
 *     → 返回 { related_memory: "历史记录文本" }
 *
 *   saveContext({ docPath, userInput, retryCount, analysis, plan },
 *               { result, executionLog, failedSteps })
 *     → 保存一次执行记录到内存
 *
 *   clear()
 *     → 清除所有记录
 *
 * 【存储结构】
 *   每条记忆 = { docPath, userInput, retryCount, result,
 *                actions, plan, failedSteps, errorMessage, timestamp }
 *   最多保留 MAX_MEMORIES 条，按时间倒序检索
 * ================================================================
 */

import { BaseMemory } from "@langchain/core/memory";

// ================================================================
// 类型定义
// ================================================================

export interface MemoryEntry {
  docPath: string;
  userInput: string;
  retryCount: number;
  result: string;
  actions: any[];
  plan: any;
  failedSteps: string[];
  errorMessage: string;
  timestamp: number;
}

const MAX_MEMORIES = 20;

// ================================================================
// DocAgentMemory — 标准的 BaseMemory 子类
// ================================================================

export class DocAgentMemory extends BaseMemory {
  private memories: MemoryEntry[] = [];
  private maxMemories: number;

  constructor(maxMemories: number = MAX_MEMORIES) {
    super();
    this.maxMemories = maxMemories;
  }

  /**
   * BaseMemory 要求的 memoryKeys getter
   * 返回此记忆模块管理的变量名列表
   */
  get memoryKeys(): string[] {
    return ["related_memory"];
  }

  /**
   * 加载记忆变量
   *
   * 【输入】
   *   values.docPath   — 文档路径/ID
   *   values.userInput — 用户输入（用于关键词匹配）
   *
   * 【返回】
   *   { related_memory: "格式化的历史记录文本" }
   */
  async loadMemoryVariables(values: Record<string, any>): Promise<Record<string, any>> {
    const docPath = values.docPath;
    const userInput = values.userInput;

    if (this.memories.length === 0) {
      return { related_memory: "无相关历史记录" };
    }

    const relevantMemories: string[] = [];

    for (let i = this.memories.length - 1; i >= 0; i--) {
      const mem = this.memories[i];
      if (mem.docPath !== docPath) continue;

      if (this.isRelated(mem, userInput)) {
        relevantMemories.push(this.formatMemoryHistory(mem));
      }
    }

    if (relevantMemories.length === 0) {
      return { related_memory: "无相关历史记录" };
    }

    // 返回最近的 3 条
    return {
      related_memory: relevantMemories.slice(0, 3).join("\n\n--- ---\n\n"),
    };
  }

  /**
   * 保存上下文（一次执行记录）
   *
   * 【输入】
   *   inputValues:  { docPath, userInput, retryCount, analysis, plan }
   *   outputValues: { result, executionLog, failedSteps }
   */
  async saveContext(
    inputValues: Record<string, any>,
    outputValues: Record<string, any>
  ): Promise<void> {
    const docPath = inputValues.docPath;
    const userInput = inputValues.userInput;
    const retryCount = inputValues.retryCount ?? 0;
    const analysis = inputValues.analysis;
    const plan = inputValues.plan;
    const result = outputValues.result ?? "";
    const executionLog = outputValues.executionLog ?? "";
    const failedSteps: string[] = outputValues.failedSteps ?? [];

    const errorMessage = this.extractErrorMessage(executionLog, result);

    // 替换同一需求的旧记录
    this.memories = this.memories.filter((mem) => {
      if (mem.docPath !== docPath || mem.userInput !== userInput) return true;
      if (result.includes("成功")) return false; // 新的成功记录覆盖旧的
      return false; // 新的失败记录覆盖旧的
    });

    // 添加新记录
    this.memories.push({
      docPath,
      userInput,
      retryCount,
      result,
      actions: analysis?.actions || [],
      plan,
      failedSteps,
      errorMessage,
      timestamp: Date.now(),
    });

    // 限制数量
    if (this.memories.length > this.maxMemories) {
      this.memories = this.memories.slice(-this.maxMemories);
    }

    console.log(
      "[DocAgentMemory] 已记录:",
      result.substring(0, 50),
      "| 错误:",
      errorMessage?.substring(0, 30) || "无"
    );
  }

  /**
   * 清除所有记忆
   */
  async clear(): Promise<void> {
    this.memories = [];
    console.log("[DocAgentMemory] 已清除所有记忆");
  }

  /**
   * 获取当前所有记忆（调试用）
   */
  getMemories(): MemoryEntry[] {
    return this.memories;
  }

  // ================================================================
  // 内部辅助方法
  // ================================================================

  /**
   * 判断一条记忆是否与用户输入相关
   */
  private isRelated(mem: MemoryEntry, userInput: string): boolean {
    if (mem.userInput === userInput) return true;

    const keywords = userInput.split(/[\s,，、]/).filter((k) => k.length > 1);
    for (const kw of keywords) {
      if (mem.userInput.includes(kw) || mem.errorMessage.includes(kw)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 格式化记忆为可读文本
   */
  private formatMemoryHistory(mem: MemoryEntry): string {
    const lines: string[] = [
      `【第 ${mem.retryCount + 1} 次尝试】`,
      `需求: ${mem.userInput}`,
      `结果: ${mem.result}`,
    ];

    if (mem.errorMessage) {
      lines.push(`失败原因: ${mem.errorMessage}`);
    }
    if (mem.failedSteps?.length > 0) {
      lines.push(`失败步骤: ${mem.failedSteps.join(", ")}`);
    }
    if (mem.plan?.tasks?.length > 0) {
      lines.push(
        `任务清单: ${mem.plan.tasks.map((t: any) => t.goal || t.action).join(", ")}`
      );
    }
    if (mem.result.includes("成功") && mem.plan?.tasks) {
      lines.push(`有效方案: ${JSON.stringify(mem.plan.tasks)}`);
    }

    return lines.join("\n");
  }

  /**
   * 从执行日志中提取错误信息
   */
  private extractErrorMessage(executionLog: string, result: string): string {
    const lines = executionLog.split("\n");
    const errors: string[] = [];

    for (const line of lines) {
      if (line.includes("失败") && line.includes("[工具]")) {
        errors.push(line.replace("[工具]", "").trim());
      }
    }

    if (errors.length > 0) return errors.join("; ");

    if (result.includes("失败")) {
      const match = result.match(/原因[：:](.+)/);
      if (match) return match[1].trim();
    }

    return "";
  }
}

// ================================================================
// 全局单例 + 便捷包装函数（保持旧版接口兼容）
// ================================================================

/** 全局记忆实例 */
let globalMemory: DocAgentMemory = new DocAgentMemory();

/**
 * 检索相关记忆（包装函数）
 * 内部调用 globalMemory.loadMemoryVariables()
 */
export function retrieveMemory(docPath: string, userInput: string): string {
  // 同步方式调用，内部实际是同步操作
  // 为了兼容旧接口，这里用同步方式直接访问内部数据
  const mem = globalMemory as any;
  const memories: MemoryEntry[] = mem.memories || [];

  if (memories.length === 0) return "无相关历史记录";

  const relevantMemories: string[] = [];
  for (let i = memories.length - 1; i >= 0; i--) {
    const m = memories[i];
    if (m.docPath !== docPath) continue;

    // 简单的关键词匹配
    const isRelated = m.userInput === userInput ||
      userInput.split(/[\s,，、]/).filter((k: string) => k.length > 1)
        .some((kw: string) => m.userInput.includes(kw) || m.errorMessage.includes(kw));

    if (isRelated) {
      relevantMemories.push(formatEntry(m));
    }
  }

  if (relevantMemories.length === 0) return "无相关历史记录";
  return relevantMemories.slice(0, 3).join("\n\n--- ---\n\n");
}

/** 格式化单条记录的辅助函数 */
function formatEntry(mem: MemoryEntry): string {
  const lines: string[] = [
    `【第 ${mem.retryCount + 1} 次尝试】`,
    `需求: ${mem.userInput}`,
    `结果: ${mem.result}`,
  ];
  if (mem.errorMessage) lines.push(`失败原因: ${mem.errorMessage}`);
  if (mem.failedSteps?.length > 0) lines.push(`失败步骤: ${mem.failedSteps.join(", ")}`);
  if (mem.plan?.tasks?.length > 0) {
    lines.push(`任务清单: ${mem.plan.tasks.map((t: any) => t.goal || t.action).join(", ")}`);
  }
  if (mem.result.includes("成功") && mem.plan?.tasks) {
    lines.push(`有效方案: ${JSON.stringify(mem.plan.tasks)}`);
  }
  return lines.join("\n");
}

/**
 * 保存记忆（包装函数）
 * 内部调用 globalMemory.saveContext()
 */
export function manageMemory(
  docPath: string,
  userInput: string,
  retryCount: number,
  result: string,
  analysis: any,
  plan: any,
  executionLog: string = "",
  failedSteps: string[] = []
): void {
  const errorMessage = extractErrorMessageSimple(executionLog, result);

  // 直接操作内部数组（同步 API）
  const mem = globalMemory as any;
  let memories: MemoryEntry[] = mem.memories || [];

  memories = memories.filter((m: MemoryEntry) => {
    if (m.docPath !== docPath || m.userInput !== userInput) return true;
    return false; // 替换旧的
  });

  memories.push({
    docPath,
    userInput,
    retryCount,
    result,
    actions: analysis?.actions || [],
    plan,
    failedSteps,
    errorMessage,
    timestamp: Date.now(),
  });

  if (memories.length > MAX_MEMORIES) {
    memories = memories.slice(-MAX_MEMORIES);
  }

  mem.memories = memories;

  console.log("[记忆管理] 已记录:", result.substring(0, 50), "| 错误:", errorMessage?.substring(0, 30) || "无");
}

function extractErrorMessageSimple(executionLog: string, result: string): string {
  const lines = executionLog.split("\n");
  const errors: string[] = [];
  for (const line of lines) {
    if (line.includes("失败") && line.includes("[工具]")) {
      errors.push(line.replace("[工具]", "").trim());
    }
  }
  if (errors.length > 0) return errors.join("; ");
  if (result.includes("失败")) {
    const match = result.match(/原因[：:](.+)/);
    if (match) return match[1].trim();
  }
  return "";
}

/**
 * 检查是否需要用户介入
 */
export function needsUserIntervention(result: string, errorMessage: string): boolean {
  const nonRetryablePatterns = [
    "文档不存在", "文件不存在", "无法打开", "权限不足",
    "不支持", "格式错误", "内容为空", "需要用户提供", "无法确定",
  ];
  const checkText = result + " " + errorMessage;
  return nonRetryablePatterns.some((p) => checkText.includes(p));
}

/**
 * 清除所有记忆
 */
export function clearMemories(): void {
  (globalMemory as any).memories = [];
  console.log("[记忆管理] 已清除所有记忆");
}

/**
 * 获取当前记忆列表（调试用）
 */
export function getMemories(): MemoryEntry[] {
  return (globalMemory as any).memories || [];
}

/**
 * 获取全局 DocAgentMemory 实例（供 LangChain 集成使用）
 */
export function getMemoryInstance(): DocAgentMemory {
  return globalMemory;
}
