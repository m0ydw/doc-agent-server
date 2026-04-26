/**
 * 单 Agent 主流程
 */

import { LLM } from "../core/llm";
import { AnalyzeTool } from "../tools/analyzeTool";
import { PlanTool } from "../tools/planTool";
import { ExecuteTool } from "../tools/executeTool";
import { ValidateTool } from "../tools/validateTool";
import { retrieveMemory, manageMemory } from "../core/memory";

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
    this.executeTool = new ExecuteTool(docId);
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

      var executeState = {
        plan: state.plan,
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

      manageMemory(
        state.doc_path,
        state.user_input,
        state.retry_count,
        state.result,
        state.analysis,
        state.plan
      );

      if (state.result.indexOf("成功") >= 0) {
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
    };

    while (state.retry_count < this.max_retry) {
      state.related_memory = retrieveMemory(state.doc_path, state.user_input);
      yield "[记忆检索] 相关历史记录: " + state.related_memory + "\n";

      var analyzeState = {
        user_input: state.user_input,
        related_memory: state.related_memory,
      };
      yield "[分析阶段] 开始分析用户需求...\n";
      
      // 流式输出分析内容，同时收集完整内容用于解析
      var analyzeContent = "";
      for await (var chunk of this.analyzeTool.streamAnalyze(analyzeState)) {
        analyzeContent += chunk;
        yield chunk;
      }
      // 解析分析结果
      state.analysis = this.analyzeTool.parseResponse(analyzeContent)?.analysis || { actions: [] };
      yield "\n[分析结果解析] " + JSON.stringify(state.analysis) + "\n";

      var planState = {
        analysis: state.analysis,
        related_memory: state.related_memory,
      };
      yield "[规划阶段] 开始生成执行计划...\n";
      
      // 流式输出计划内容，同时收集完整内容用于解析
      var planContent = "";
      for await (var chunk of this.planTool.streamPlan(planState)) {
        planContent += chunk;
        yield chunk;
      }
      // 解析计划结果
      state.plan = this.planTool.parseResponse(planContent)?.plan || { steps: [] };
      yield "\n[计划结果解析] " + JSON.stringify(state.plan) + "\n";

      var executeState = {
        plan: state.plan,
      };
      yield "[执行阶段] 开始执行计划...\n";
      for await (var chunk of this.executeTool.streamExecute(executeState)) {
        yield chunk;
      }
      yield "\n";

      var validateState = {
        execution_log: state.execution_log,
      };
      yield "[验证阶段] 开始验证执行结果...\n";
      for await (var chunk of this.validateTool.streamValidate(validateState)) {
        yield chunk;
      }
      yield "\n";

      manageMemory(
        state.doc_path,
        state.user_input,
        state.retry_count,
        state.result,
        state.analysis,
        state.plan
      );

      if (state.result.indexOf("成功") >= 0) {
        yield "[最终结果] 任务成功完成！\n";
        return;
      }

      state.retry_count++;
      yield "[重试] 任务失败，开始第" + state.retry_count + "次重试...\n";
    }

    state.result = "重试" + this.max_retry + "次失败，任务终止";
    yield "[最终结果] " + state.result + "\n";
  }
}

export function createSingleDocAgent(llm: LLM, docId: string, doc_path: string): SingleDocAgent {
  return new SingleDocAgent(llm, docId, doc_path);
}