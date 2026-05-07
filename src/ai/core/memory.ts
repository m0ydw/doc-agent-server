/**
 * 记忆管理模块 — LangChain BaseMemory 子类
 *
 * DocAgentMemory 继承自 LangChain 的 BaseMemory，实现了标准化的
 * loadMemoryVariables() / saveContext() / clear() 接口。
 * 外部调用均通过公共接口，不再通过 as any 绕过封装。
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
  actions: unknown[];
  plan: unknown;
  failedSteps: string[];
  errorMessage: string;
  timestamp: number;
}

const MAX_MEMORIES = 20;

// ================================================================
// DocAgentMemory
// ================================================================

export class DocAgentMemory extends BaseMemory {
  private memories: MemoryEntry[] = [];
  private maxMemories: number;

  constructor(maxMemories: number = MAX_MEMORIES) {
    super();
    this.maxMemories = maxMemories;
  }

  get memoryKeys(): string[] {
    return ["related_memory"];
  }

  async loadMemoryVariables(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const docPath = values.docPath as string;
    const userInput = values.userInput as string;

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

    return { related_memory: relevantMemories.slice(0, 3).join("\n\n--- ---\n\n") };
  }

  async saveContext(
    inputValues: Record<string, unknown>,
    outputValues: Record<string, unknown>
  ): Promise<void> {
    const docPath = inputValues.docPath as string;
    const userInput = inputValues.userInput as string;
    const retryCount = (inputValues.retryCount as number) ?? 0;
    const analysis = inputValues.analysis;
    const plan = inputValues.plan;
    const result = (outputValues.result as string) ?? "";
    const executionLog = (outputValues.executionLog as string) ?? "";
    const failedSteps: string[] = (outputValues.failedSteps as string[]) ?? [];

    const errorMessage = this.extractErrorMessage(executionLog, result);

    // 替换同一需求的旧记录
    this.memories = this.memories.filter((mem) => {
      if (mem.docPath !== docPath || mem.userInput !== userInput) return true;
      return false; // 替换旧的
    });

    const analysisActions = (analysis && typeof analysis === 'object' && 'actions' in analysis)
      ? (analysis as Record<string, unknown>).actions
      : [];

    this.memories.push({
      docPath,
      userInput,
      retryCount,
      result,
      actions: analysisActions as unknown[] || [],
      plan,
      failedSteps,
      errorMessage,
      timestamp: Date.now(),
    });

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

  async clear(): Promise<void> {
    this.memories = [];
    console.log("[DocAgentMemory] 已清除所有记忆");
  }

  getMemories(): MemoryEntry[] {
    return this.memories;
  }

  // ================================================================
  // 内部辅助
  // ================================================================

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

  private formatMemoryHistory(mem: MemoryEntry): string {
    const lines: string[] = [
      `【第 ${mem.retryCount + 1} 次尝试】`,
      `需求: ${mem.userInput}`,
      `结果: ${mem.result}`,
    ];
    if (mem.errorMessage) lines.push(`失败原因: ${mem.errorMessage}`);
    if (mem.failedSteps?.length > 0) lines.push(`失败步骤: ${mem.failedSteps.join(", ")}`);
    if ((mem.plan as Record<string, unknown>)?.tasks) {
      const tasks = (mem.plan as Record<string, { tasks: Array<{ goal?: string; action?: string }> }>).tasks;
      if (Array.isArray(tasks) && tasks.length > 0) {
        lines.push(`任务清单: ${tasks.map((t: { goal?: string; action?: string }) => t.goal || t.action).join(", ")}`);
      }
    }
    if (mem.result === "成功" && (mem.plan as Record<string, unknown>)?.tasks) {
      lines.push(`有效方案: ${JSON.stringify((mem.plan as Record<string, unknown>).tasks)}`);
    }
    return lines.join("\n");
  }

  /**
   * 从执行日志中提取错误信息（修复：应在 executionLog 上匹配，而非 result）
   */
  private extractErrorMessage(executionLog: string, result: string): string {
    // 修复：原本在 result 字符串上做正则匹配，现在正确地在 executionLog 上匹配
    if (result === "失败") {
      const match = executionLog.match(/原因[：:](.+)/);
      if (match) return match[1].trim();
    }

    const lines = executionLog.split("\n");
    const errors: string[] = [];
    for (const line of lines) {
      if (line.includes("失败")) {
        errors.push(line.trim());
      }
    }
    return errors.length > 0 ? errors.join("; ") : "";
  }
}

// ================================================================
// 全局单例 + 标准接口（不再绕过封装）
// ================================================================

let globalMemory: DocAgentMemory = new DocAgentMemory();

/** 获取全局 DocAgentMemory 实例 */
export function getMemoryInstance(): DocAgentMemory {
  return globalMemory;
}

/**
 * 检索相关记忆（async 版本，使用 loadMemoryVariables）
 */
export async function retrieveMemory(docPath: string, userInput: string): Promise<string> {
  const result = await globalMemory.loadMemoryVariables({ docPath, userInput });
  return (result.related_memory as string) || "无相关历史记录";
}

/**
 * 保存记忆（async 版本，使用 saveContext）
 */
export async function manageMemory(
  docPath: string,
  userInput: string,
  retryCount: number,
  result: string,
  analysis: unknown,
  plan: unknown,
  executionLog: string = "",
  failedSteps: string[] = []
): Promise<void> {
  await globalMemory.saveContext(
    { docPath, userInput, retryCount, analysis, plan },
    { result, executionLog, failedSteps }
  );
}

/**
 * 清除所有记忆
 */
export async function clearMemories(): Promise<void> {
  await globalMemory.clear();
}

/**
 * 获取当前记忆列表
 */
export function getMemories(): MemoryEntry[] {
  return globalMemory.getMemories();
}
