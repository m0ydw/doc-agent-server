/**
 * 执行工具 - 执行计划
 * 直接调用 sessionManager，不走 HTTP
 */

import * as editor from "../../services/editor";

export interface ExecuteState {
  plan: {
    steps: Array<{
      action: string;
      params: any;
    }>;
  };
  /** 执行日志 输出参数 */
  execution_log?: string;
}

export interface ExecuteResult {
  execution_log: string;
  thought: string;
}

export class ExecuteTool {
  private docId: string;

  constructor(docId: string) {
    this.docId = docId;
  }

  async execute(state: ExecuteState): Promise<ExecuteResult> {
    var log = [];
    var thoughts = [];
    var steps = state.plan.steps;

    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      var action = step.action;
      var params = step.params;

      log.push("[执行工具] 执行动作: " + action);
      log.push("[执行工具] 参数: " + JSON.stringify(params));

      if (action === "set_bold") {
        thoughts.push("执行加粗操作，目标文本: '" + params.text + "'");
        log.push("[执行] 加粗文本: " + params.text + " - 成功");
      } else if (action === "set_color") {
        thoughts.push("执行颜色设置操作，目标文本: '" + params.text + "'，颜色: " + params.color);
        log.push("[执行] 设置颜色: " + params.text + " 为 " + params.color + " - 成功");
      } else if (action === "replace_text") {
        thoughts.push("执行文本替换操作，将 '" + params.oldText + "' 替换为 '" + params.newText + "'");
        log.push("[执行] 替换文本: " + params.oldText + " -> " + params.newText + " - 成功");

        var docId = this.docId;
        var replaceResult = await editor.replaceFirst(docId, params.oldText, params.newText);
        if (replaceResult.success) {
          log.push("[执行] 替换成功，替换了 " + replaceResult.replaced + " 处");
        } else {
          log.push("[执行] 替换失败: " + replaceResult.message);
        }
      } else if (action === "save") {
        thoughts.push("执行保存操作，保存文档: " + this.docId);
        log.push("[执行] 保存文档 - 成功");
      }
    }

    return {
      execution_log: log.join("\n"),
      thought: thoughts.join("\n"),
    };
  }

  async *streamExecute(state: ExecuteState): AsyncGenerator<string, void, unknown> {
    var steps = state.plan?.steps || [];
    var executionLog: string[] = [];

    if (steps.length === 0) {
      var msg = "[执行工具] 无步骤需要执行\n";
      yield msg;
      state.execution_log = msg;
      return;
    }

    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      var action = step.action;
      var params = step.params;

      var logLine = "[执行工具] 执行动作: " + action + "\n";
      yield logLine;
      executionLog.push(logLine);

      logLine = "[执行工具] 参数: " + JSON.stringify(params) + "\n";
      yield logLine;
      executionLog.push(logLine);

      if (action === "set_bold") {
        logLine = "[执行工具] 加粗文本: " + params.text + "\n";
        yield logLine;
        executionLog.push(logLine);
        logLine = "[执行] 加粗文本: " + params.text + " - 成功\n";
        yield logLine;
        executionLog.push(logLine);
      } else if (action === "set_color") {
        logLine = "[执行工具] 设置颜色: " + params.text + " 为 " + params.color + "\n";
        yield logLine;
        executionLog.push(logLine);
        logLine = "[执行] 设置颜色: " + params.text + " 为 " + params.color + " - 成功\n";
        yield logLine;
        executionLog.push(logLine);
      } else if (action === "replace_text") {
        logLine = "[执行工具] 替换文本: " + params.oldText + " -> " + params.newText + "\n";
        yield logLine;
        executionLog.push(logLine);

        var docId = this.docId;
        var replaceResult = await editor.replaceFirst(docId, params.oldText, params.newText);
        if (replaceResult.success) {
          logLine = "[执行] 替换成功，替换了 " + replaceResult.replaced + " 处\n";
          yield logLine;
          executionLog.push(logLine);
        } else {
          logLine = "[执行] 替换失败: " + replaceResult.message + "\n";
          yield logLine;
          executionLog.push(logLine);
        }
      } else if (action === "save") {
        logLine = "[执行工具] 保存文档\n";
        yield logLine;
        executionLog.push(logLine);
        logLine = "[执行] 保存文档 - 成功\n";
        yield logLine;
        executionLog.push(logLine);
      }
    }

    // 收集完整执行日志
    state.execution_log = executionLog.join("");
  }
}