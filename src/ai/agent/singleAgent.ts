/**
 * 单 Agent 主流程
 * 增强版：记忆传递、执行日志收集、验证结果解析、自动请求用户介入
 */

import { LLM } from "../core/llm";
import { AnalyzeTool } from "../tools/analyzeTool";
import { PlanTool } from "../tools/planTool";
import { ExecuteTool } from "../tools/executeTool";
import { ValidateTool } from "../tools/validateTool";
import { retrieveMemory, manageMemory, needsUserIntervention } from "../core/memory";

export interface AgentState {
  user_input: string;
  docId: string;
  doc_path: string;
  retry_count: number;
  related_memory: string;
  analysis: any;
  analysis_thought: string;
  plan: any;
  plan_thought: string;
  execution_log: string;
  execution_thought: string;
  result: string;
  validate_thought: string;
  retryable: boolean;
  needsUserInput: boolean;
  failedSteps: string[];
}

export class SingleDocAgent {
  private llm: LLM;
  private docId: string;
  private doc_path: string;
  private max_retry: number = 3;
  private analyzeTool: AnalyzeTool;
  private planTool: PlanTool;
  private executeTool: ExecuteTool;
  private validateTool: ValidateTool;

  constructor(llm: LLM, docId: string, doc_path: string) {
    this.llm = llm;
    this.docId = docId;
    this.doc_path = doc_path;
    this.analyzeTool = new AnalyzeTool(llm);
    this.planTool = new PlanTool(llm);
    this.executeTool = new ExecuteTool();
    this.validateTool = new ValidateTool(llm);
  }

  async run(userInput: string): Promise<AgentState> {
    var state: AgentState = {
      user_input: userInput,
      docId: this.docId,
      doc_path: this.doc_path,
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

    while (state.retry_count < this.max_retry) {
      state.related_memory = retrieveMemory(state.doc_path, state.user_input);

      var analyzeState = {
        user_input: state.user_input,
        related_memory: state.related_memory,
      };
      var analyzeResult = await this.analyzeTool.analyze(analyzeState);
      state.analysis = analyzeResult.analysis;
      state.analysis_thought = analyzeResult.thought;

      var planState = {
        analysis: state.analysis,
        related_memory: state.related_memory,
      };
      var planResult = await this.planTool.plan(planState);
      state.plan = planResult.plan;
      state.plan_thought = planResult.thought;

      var executeState: any = {
        plan: state.plan,
        execution_log: "",
        targetDocId: this.docId,
      };
      var executeResult = await this.executeTool.execute(executeState);
      state.execution_log = executeResult.execution_log;
      state.execution_thought = executeResult.thought;

      var validateState = {
        execution_log: state.execution_log,
      };
      var validateResult = await this.validateTool.validate(validateState);
      state.result = validateResult.result;
      state.validate_thought = validateResult.thought;
      state.retryable = validateResult.retryable;
      state.needsUserInput = validateResult.needsUserInput;

      // 提取失败步骤
      state.failedSteps = this.extractFailedSteps(state.execution_log);

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

      if (state.result.indexOf("成功") >= 0) {
        return state;
      }

      // 检查是否需要用户介入
      if (!state.retryable || state.needsUserInput) {
        state.result = "【需要用户介入】" + state.result;
        return state;
      }

      state.retry_count++;
    }

    state.result = "重试" + this.max_retry + "次失败，任务终止";
    return state;
  }

  async *streamRun(userInput: string): AsyncGenerator<string, void, unknown> {
    var state: AgentState = {
      user_input: userInput,
      docId: this.docId,
      doc_path: this.doc_path,
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

    while (state.retry_count < this.max_retry) {
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
      for await (var chunk of this.analyzeTool.streamAnalyze(analyzeState)) {
        analyzeContent += chunk;
        yield chunk;
      }
      state.analysis = this.analyzeTool.parseResponse(analyzeContent)?.analysis || { actions: [] };
      yield "\n[分析结果解析] " + JSON.stringify(state.analysis) + "\n";

      // ===== 规划阶段 =====
      var planState = {
        analysis: state.analysis,
        related_memory: state.related_memory,
      };
      yield "[规划阶段] 开始生成执行计划...\n";
      
      var planContent = "";
      for await (var chunk of this.planTool.streamPlan(planState)) {
        planContent += chunk;
        yield chunk;
      }
      state.plan = this.planTool.parseResponse(planContent)?.plan || { steps: [] };
      yield "\n[计划结果解析] " + JSON.stringify(state.plan) + "\n";

      // ===== 执行阶段 =====
      var executeState: any = {
        plan: state.plan,
        execution_log: "",
        targetDocId: this.docId,
      };
      yield "[执行阶段] 开始执行计划...\n";
      for await (var chunk of this.executeTool.streamExecute(executeState)) {
        yield chunk;
      }
      // 收集执行日志
      state.execution_log = executeState.execution_log || "";
      yield "\n";

      // ===== 验证阶段 =====
      var validateState = {
        execution_log: state.execution_log,
      };
      yield "[验证阶段] 开始验证执行结果...\n";
      
      var validateContent = "";
      for await (var chunk of this.validateTool.streamValidate(validateState)) {
        validateContent += chunk;
        yield chunk;
      }
      // 解析验证结果
      var validateResult = this.validateTool.parseResponse(validateContent);
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

      // 检查是否需要用户介入（不可重试的错误）
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

      // 继续重试
      state.retry_count++;
      yield "[重试] 任务失败，开始第" + state.retry_count + "次重试...\n";
    }

    // 重试耗尽
    if (state.retry_count >= this.max_retry) {
      yield "\n" + "=".repeat(50) + "\n";
      yield "❌ 重试" + this.max_retry + "次仍然失败\n";
      yield "最终结果: " + state.result + "\n";
      if (state.failedSteps.length > 0) {
        yield "失败步骤: " + state.failedSteps.join(", ") + "\n";
      }
      yield "请检查文档是否存在，或提供更多信息。\n";
      yield "=".repeat(50) + "\n";
    }
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
}

export function createSingleDocAgent(llm: LLM, docId: string, doc_path: string): SingleDocAgent {
  return new SingleDocAgent(llm, docId, doc_path);
}