/**
 * 记忆管理模块 — LangChain BaseMemory 子类
 *
 * DocAgentMemory 继承自 LangChain 的 BaseMemory，实现了标准化的
 * loadMemoryVariables() / saveContext() / clear() 接口。
 *
 * 【设计动机】
 * 每次 Agent 执行任务后，将结果记录到记忆库。下次用户针对同一文档
 * 提出相似需求时，Agent 可以从历史记录中获取参考方案，避免重复错误。
 *
 * 【存储策略】
 * - 最多保留 20 条记忆（可配置）
 * - 同一文档+同一需求的旧记录会被替换（去重，只保留最新一次）
 * - 检索时只返回同一文档且关键词相关的记忆（最多 3 条）
 *
 * 【标准化封装】
 * 外部调用均通过公共接口（retrieveMemory / manageMemory），
 * 不再通过 as any 绕过封装直接访问内部数组。
 */

import { BaseMemory } from "@langchain/core/memory";

// ================================================================
// 类型定义
// ================================================================

/**
 * 单条记忆记录的数据结构
 *
 * 每条记录包含一次 Agent 任务的完整上下文：
 * - 输入：docPath, userInput
 * - 输出：result, actions, plan
 * - 错误信息：failedSteps, errorMessage（用于后续重试参考）
 */
export interface MemoryEntry {
  /** 目标文档路径 */
  docPath: string;
  /** 用户的自然语言需求 */
  userInput: string;
  /** 重试次数（第几次尝试） */
  retryCount: number;
  /** 执行结果（"成功" / "失败"） */
  result: string;
  /** Agent 执行的详细操作列表 */
  actions: unknown[];
  /** 执行方案（任务清单） */
  plan: unknown;
  /** 失败的步骤列表 */
  failedSteps: string[];
  /** 提取的错误原因描述 */
  errorMessage: string;
  /** 记录时间戳 */
  timestamp: number;
}

/** 最多保留的记忆条数，超出时自动移除最旧记录 */
const MAX_MEMORIES = 20;

// ================================================================
// DocAgentMemory — LangChain BaseMemory 的标准实现
//
// 提供记忆的存储、检索、清除功能。
// 类本身就是纯数据结构 + 操作逻辑，不依赖外部服务。
// ================================================================

export class DocAgentMemory extends BaseMemory {
  /** 内部记忆数组，按时间顺序存储 */
  private memories: MemoryEntry[] = [];
  /** 最大记忆容量 */
  private maxMemories: number;

  /**
   * 构造函数
   * @param maxMemories 记忆容量上限（默认 20）
   */
  constructor(maxMemories: number = MAX_MEMORIES) {
    super();
    this.maxMemories = maxMemories;
  }

  /**
   * LangChain 标准接口：返回记忆的键名列表
   * BaseMemory 会自动将 loadMemoryVariables 的返回值合并到 chain 的输入变量中
   */
  get memoryKeys(): string[] {
    return ["related_memory"];
  }

  /**
   * 加载相关记忆（LangChain 标准接口）
   *
   * 【检索策略】
   * 1. 过滤：只查找同一 docPath 的记忆
   * 2. 匹配：检查 userInput 是否存在关键词重叠
   * 3. 截断：最多返回 3 条最近的相关记忆
   * 4. 格式化：将历史记忆转为 Markdown 格式的文本块
   *
   * @param values 输入变量，包含 docPath 和 userInput
   * @returns 包含 related_memory 字段的对象
   */
  async loadMemoryVariables(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const docPath = values.docPath as string;
    const userInput = values.userInput as string;

    // 无记忆时直接返回空
    if (this.memories.length === 0) {
      return { related_memory: "无相关历史记录" };
    }

    // 从最新到最旧遍历，筛选相关记忆
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

    // 最多返回 3 条，用分隔线连接
    return { related_memory: relevantMemories.slice(0, 3).join("\n\n--- ---\n\n") };
  }

  /**
   * 保存记忆到记忆库（LangChain 标准接口）
   *
   * 【去重策略】
   * 保存前先删除同一 docPath + userInput 的旧记录，
   * 确保同一需求始终保留最新一次的执行结果。
   *
   * 【容量管理】
   * 记忆数量超过 maxMemories 时，自动截断掉最旧的记录。
   *
   * @param inputValues  输入变量（docPath, userInput, retryCount, plan 等）
   * @param outputValues 输出变量（result, executionLog, failedSteps）
   */
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

    // 从执行日志中提取错误原因文本
    const errorMessage = this.extractErrorMessage(executionLog, result);

    // 替换同一需求的旧记录（去重）
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

    // 容量控制：超出最大条数时保留最新的
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
   * 清除所有记忆（LangChain 标准接口）
   */
  async clear(): Promise<void> {
    this.memories = [];
    console.log("[DocAgentMemory] 已清除所有记忆");
  }

  /**
   * 获取当前所有记忆的只读副本（用于调试）
   * @returns 记忆数组的浅拷贝
   */
  getMemories(): MemoryEntry[] {
    return this.memories;
  }

  // ================================================================
  // 内部辅助方法
  // ================================================================

  /**
   * 判断记忆是否与当前用户输入相关
   *
   * 【匹配策略】
   * 1. 精确匹配：userInput 完全相同
   * 2. 关键词匹配：对当前输入按空格/逗号分词，检查每个词是否出现在
   *    历史记录的 userInput 或 errorMessage 中
   *
   * @param mem 历史记忆记录
   * @param userInput 当前用户输入
   * @returns 是否相关
   */
  private isRelated(mem: MemoryEntry, userInput: string): boolean {
    if (mem.userInput === userInput) return true;
    // 按空格、逗号、顿号分词，过滤单字符
    const keywords = userInput.split(/[\s,，、]/).filter((k) => k.length > 1);
    for (const kw of keywords) {
      if (mem.userInput.includes(kw) || mem.errorMessage.includes(kw)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 将记忆条目格式化为 Markdown 文本块
   * 生成的文本会直接嵌入到 LLM 的 context 中作为历史参考
   *
   * @param mem 历史记忆记录
   * @returns Markdown 格式的记忆文本
   */
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
    // 成功的记录额外附上有效方案，供后续参考复用
    if (mem.result === "成功" && (mem.plan as Record<string, unknown>)?.tasks) {
      lines.push(`有效方案: ${JSON.stringify((mem.plan as Record<string, unknown>).tasks)}`);
    }
    return lines.join("\n");
  }

  /**
   * 从执行日志中提取错误信息
   *
   * 【提取策略】
   * 1. 如果结果为"失败"，从执行日志中匹配 "原因：xxx" 格式的行
   * 2. 否则，收集所有包含"失败"关键字的行
   *
   * @param executionLog 完整的执行日志文本
   * @param result 执行结果（"成功" / "失败"）
   * @returns 提取的错误原因描述（没有则返回空字符串）
   */
  private extractErrorMessage(executionLog: string, result: string): string {
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
// 全局单例 + 标准接口
//
// 整个应用共享一个 DocAgentMemory 实例，确保记忆一致性。
// 以下函数封装了对全局实例的调用，提供类型安全的接口。
// ================================================================

/** 全局唯一的 DocAgentMemory 实例 */
let globalMemory: DocAgentMemory = new DocAgentMemory();

/**
 * 获取全局 DocAgentMemory 实例
 *
 * 整个应用共享同一个记忆实例，确保所有 Agent 操作都能访问到
 * 其他 Agent 留下的记忆。
 */
export function getMemoryInstance(): DocAgentMemory {
  return globalMemory;
}

/**
 * 检索与当前需求相关的历史记忆
 *
 * 这是高层封装，内部调用 DocAgentMemory.loadMemoryVariables()
 *
 * @param docPath   目标文档路径
 * @param userInput 用户自然语言需求
 * @returns 格式化的记忆文本（无相关记录时返回"无相关历史记录"）
 */
export async function retrieveMemory(docPath: string, userInput: string): Promise<string> {
  const result = await globalMemory.loadMemoryVariables({ docPath, userInput });
  return (result.related_memory as string) || "无相关历史记录";
}

/**
 * 保存一次 Agent 执行的结果到记忆库
 *
 * 这是高层封装，内部调用 DocAgentMemory.saveContext()
 *
 * @param docPath       目标文档路径
 * @param userInput     用户自然语言需求
 * @param retryCount    重试次数
 * @param result        执行结果（"成功" / "失败"）
 * @param analysis      Agent 分析结果
 * @param plan          执行方案
 * @param executionLog  执行日志
 * @param failedSteps   失败的步骤
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
 * 清除所有记忆（重置记忆库）
 */
export async function clearMemories(): Promise<void> {
  await globalMemory.clear();
}

/**
 * 获取当前所有记忆条目（用于调试和前端展示）
 * @returns 记忆条目数组
 */
export function getMemories(): MemoryEntry[] {
  return globalMemory.getMemories();
}
