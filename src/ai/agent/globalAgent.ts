/**
 * 全局 LLM Agent（单例）
 * 服务启动时创建，常驻内存，跨请求保持记忆
 * 多文档感知：通过 FileRegistry 知道所有可用文档
 * 接收 contextDocId（前端当前激活的文档 ID），动态确定操作目标
 */

import { LLM } from "../core/llm";
import { createZhipuAI } from "../core/aiWrapper/zhipuAI";
import { AnalyzeTool } from "../tools/analyzeTool";
import { PlanTool } from "../tools/planTool";
import { ExecuteTool } from "../tools/executeTool";
import { ValidateTool } from "../tools/validateTool";
import { retrieveMemory, manageMemory, needsUserIntervention, clearMemories, getMemories } from "../core/memory";
import { fileRegistry } from "../../services/fileRegistry";

const MAX_RETRY = 3;

export interface GlobalAgentConfig {
  apiKey?: string;
  modelName?: string;
  temperature?: number;
}

export interface ProcessParams {
  message: string;
  contextDocId?: string;
}

class GlobalAgent {
  private llm: LLM | null = null;
  private analyzeTool: AnalyzeTool | null = null;
  private planTool: PlanTool | null = null;
  private executeTool: ExecuteTool | null = null;
  private validateTool: ValidateTool | null = null;
  private initialized = false;

  /**
   * 初始化 Agent（创建 LLM 和 Tools）
   */
  initialize(config?: GlobalAgentConfig): void {
    if (this.initialized) {
      console.log("[GlobalAgent] 已经初始化，跳过");
      return;
    }

    var apiKey = config?.apiKey || process.env.ZHIPUAI_API_KEY;
    if (!apiKey) {
      console.warn("[GlobalAgent] 未配置 ZHIPUAI_API_KEY，Agent 无法工作");
      return;
    }

    this.llm = createZhipuAI({
      apiKey: apiKey,
      modelName: config?.modelName || "glm-4-flash",
      temperature: config?.temperature ?? 0.1,
    });

    this.analyzeTool = new AnalyzeTool(this.llm);
    this.planTool = new PlanTool(this.llm);
    this.executeTool = new ExecuteTool();
    this.validateTool = new ValidateTool(this.llm);

    this.initialized = true;
    console.log("[GlobalAgent] 初始化完成");
  }

  /**
   * 检查是否已初始化
   */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 处理用户消息，SSE 流式返回
   */
  async *streamProcess(params: ProcessParams): AsyncGenerator<string, void, unknown> {
    if (!this.initialized || !this.llm) {
      yield "[全局Agent] 错误: Agent 未初始化，请先配置 API Key\n";
      return;
    }

    var userInput = params.message;
    var contextDocId = params.contextDocId;

    // 获取文档上下文
    var docContext = fileRegistry.toContextString(contextDocId);
    yield "[文档列表] " + docContext.replace(/\n/g, "\n[文档列表] ") + "\n";

    // 自动确定目标文档
    var targetDocId = this.resolveTargetDocId(userInput, contextDocId);

    if (!targetDocId) {
      yield "\n" + "=".repeat(50) + "\n";
      yield "⚠️ 无法确定目标文档\n";
      yield "当前没有可操作的文档，请先上传 .docx 文件。\n";
      yield "=".repeat(50) + "\n";
      return;
    }

    var targetEntry = fileRegistry.get(targetDocId);
    var targetName = targetEntry ? targetEntry.originalName : targetDocId;
    yield "[目标文档] " + targetName + " (" + targetDocId + ")\n\n";

    // ===== Agent 主循环 =====
    var state: any = {
      user_input: userInput,
      docId: targetDocId,
      doc_path: targetDocId, // memory 模块使用 doc_path 作为 key，这里传入 docId
      retry_count: 0,
      related_memory: "",
      analysis: {},
      analysis_thought: "",
      plan: {},
      plan_thought: "",
      execution_log: "",
      execution_thought: "",
      result: "",
      validate_thought: "",
      retryable: true,
      needsUserInput: false,
      failedSteps: [],
    };

    while (state.retry_count < MAX_RETRY) {
      // 检索相关记忆
      state.related_memory = retrieveMemory(state.doc_path, state.user_input);
      yield "[记忆检索] 相关历史记录: " + state.related_memory + "\n";

      // ===== 分析阶段 =====
      var analyzeState = {
        user_input: state.user_input,
        related_memory: state.related_memory,
      };
      yield "[分析阶段] 开始分析用户需求...\n";

      var analyzeContent = "";
      for await (var chunk of this.analyzeTool!.streamAnalyze(analyzeState)) {
        analyzeContent += chunk;
        yield chunk;
      }
      state.analysis = this.analyzeTool!.parseResponse(analyzeContent)?.analysis || { actions: [] };
      yield "\n[分析结果解析] " + JSON.stringify(state.analysis) + "\n";

      // 从分析结果中重新确认目标文档
      var resolvedDocId = this.resolveTargetDocIdFromAnalysis(userInput, contextDocId, state.analysis);
      if (resolvedDocId && resolvedDocId !== targetDocId) {
        targetDocId = resolvedDocId;
        state.docId = targetDocId;
        state.doc_path = targetDocId;
        var newEntry = fileRegistry.get(targetDocId);
        yield "[切换目标] 切换到文档: " + (newEntry ? newEntry.originalName : targetDocId) + "\n";
      }

      // ===== 规划阶段 =====
      var planState = {
        analysis: state.analysis,
        related_memory: state.related_memory,
      };
      yield "[规划阶段] 开始生成执行计划...\n";

      var planContent = "";
      for await (var chunk of this.planTool!.streamPlan(planState)) {
        planContent += chunk;
        yield chunk;
      }
      state.plan = this.planTool!.parseResponse(planContent)?.plan || { steps: [] };
      yield "\n[计划结果解析] " + JSON.stringify(state.plan) + "\n";

      // ===== 执行阶段 =====
      var executeState: any = {
        plan: state.plan,
        execution_log: "",
        targetDocId: targetDocId,
      };
      yield "[执行阶段] 开始执行计划...\n";
      for await (var chunk of this.executeTool!.streamExecute(executeState)) {
        yield chunk;
      }
      state.execution_log = executeState.execution_log || "";
      yield "\n";

      // ===== 验证阶段 =====
      var validateState = {
        execution_log: state.execution_log,
      };
      yield "[验证阶段] 开始验证执行结果...\n";

      var validateContent = "";
      for await (var chunk of this.validateTool!.streamValidate(validateState)) {
        validateContent += chunk;
        yield chunk;
      }
      var validateResult = this.validateTool!.parseResponse(validateContent);
      state.result = validateResult.result;
      state.retryable = validateResult.retryable;
      state.needsUserInput = validateResult.needsUserInput;
      yield "\n[验证结果] result=" + state.result + ", retryable=" + state.retryable + ", needsUserInput=" + state.needsUserInput + "\n";

      // 提取失败步骤
      state.failedSteps = this.extractFailedSteps(state.execution_log);

      // 保存记忆
      manageMemory(
        state.doc_path,
        state.user_input,
        state.retry_count,
        state.result,
        state.analysis,
        state.plan,
        state.execution_log,
        state.failedSteps
      );

      // 检查是否成功
      if (state.result.indexOf("成功") >= 0) {
        yield "[最终结果] 任务成功完成！\n";
        return;
      }

      // 检查是否需要用户介入
      if (!state.retryable || state.needsUserInput) {
        yield "\n" + "=".repeat(50) + "\n";
        yield "⚠️ 【需要用户介入】\n";
        yield "问题无法通过自动重试解决。\n";
        yield "失败原因: " + state.result + "\n";
        if (state.failedSteps.length > 0) {
          yield "失败步骤: " + state.failedSteps.join(", ") + "\n";
        }
        yield "请提供更多信息或确认操作。\n";
        yield "=".repeat(50) + "\n";
        return;
      }

      state.retry_count++;
      yield "[重试] 任务失败，开始第" + state.retry_count + "次重试...\n";
    }

    // 重试耗尽
    if (state.retry_count >= MAX_RETRY) {
      yield "\n" + "=".repeat(50) + "\n";
      yield "❌ 重试" + MAX_RETRY + "次仍然失败\n";
      yield "最终结果: " + state.result + "\n";
      if (state.failedSteps.length > 0) {
        yield "失败步骤: " + state.failedSteps.join(", ") + "\n";
      }
      yield "=".repeat(50) + "\n";
    }
  }

  /**
   * 确定目标文档 ID
   */
  private resolveTargetDocId(userInput: string, contextDocId?: string): string | undefined {
    var allDocs = fileRegistry.getAll();
    if (allDocs.length === 0) return undefined;
    if (allDocs.length === 1) return allDocs[0].docId;

    // 1. 用户消息中明确提到文档名
    for (var doc of allDocs) {
      if (userInput.indexOf(doc.originalName) >= 0) {
        return doc.docId;
      }
      // 短名匹配（去掉扩展名）
      var shortName = doc.originalName.replace(/\.\w+$/, "");
      if (userInput.indexOf(shortName) >= 0) {
        return doc.docId;
      }
    }

    // 2. 使用 contextDocId（前端当前激活的文档）
    if (contextDocId && fileRegistry.get(contextDocId)) {
      return contextDocId;
    }

    // 3. 默认第一个文档
    return allDocs[0].docId;
  }

  /**
   * 从 LLM 分析结果中重新确认目标文档
   */
  private resolveTargetDocIdFromAnalysis(userInput: string, contextDocId?: string, analysis?: any): string | undefined {
    // 先看 analysis 中是否有 target 信息提到文档名
    if (analysis?.actions) {
      for (var action of analysis.actions) {
        if (action.target) {
          var targetStr = String(action.target);
          var found = fileRegistry.getByName(targetStr);
          if (found) return found.docId;
        }
      }
    }
    // 回退到基础解析
    return this.resolveTargetDocId(userInput, contextDocId);
  }

  /**
   * 从执行日志中提取失败步骤
   */
  private extractFailedSteps(executionLog: string): string[] {
    var failed: string[] = [];
    var lines = executionLog.split("\n");
    for (var line of lines) {
      if (line.indexOf("[执行]") >= 0 && line.indexOf("失败") >= 0) {
        var actionMatch = line.match(/\[执行\]\s*(.+?)\s*[-–—]\s*失败/);
        if (actionMatch) {
          failed.push(actionMatch[1].trim());
        }
      }
    }
    return failed;
  }

  /**
   * 重置记忆
   */
  reset(): void {
    clearMemories();
    console.log("[GlobalAgent] 记忆已重置");
  }

  /**
   * 获取当前状态
   */
  getStatus(): { initialized: boolean; docCount: number; memoryLength: number } {
    return {
      initialized: this.initialized,
      docCount: fileRegistry.count,
      memoryLength: getMemories().length,
    };
  }
}

// ===== 全局单例管理 =====

var globalAgent: GlobalAgent | null = null;

/**
 * 初始化全局 Agent
 */
export async function initGlobalAgent(config?: GlobalAgentConfig): Promise<void> {
  if (globalAgent) {
    console.log("[GlobalAgent] 已存在，跳过初始化");
    return;
  }
  globalAgent = new GlobalAgent();
  globalAgent.initialize(config);
}

/**
 * 获取全局 Agent 实例
 */
export function getGlobalAgent(): GlobalAgent {
  if (!globalAgent) {
    globalAgent = new GlobalAgent();
    console.warn("[GlobalAgent] 未初始化就调用 getGlobalAgent()，返回未初始化实例");
  }
  return globalAgent;
}

/**
 * 重置全局 Agent
 */
export function resetGlobalAgent(): void {
  if (globalAgent) {
    globalAgent.reset();
  }
}
