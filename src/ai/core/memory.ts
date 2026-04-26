/**
 * 记忆管理模块 - 增强版
 * 记录详细失败原因，支持跨重试传递历史
 */

var memories: Array<{
  docPath: string;
  userInput: string;
  retryCount: number;
  result: string;
  actions: any[];
  plan: any;
  failedSteps: string[];
  errorMessage: string;
  timestamp: number;
}> = [];

const MAX_MEMORIES = 20;

/**
 * 检索相关记忆
 * 返回包含失败原因和之前方案的历史记录
 */
export function retrieveMemory(docPath: string, userInput: string): string {
  if (memories.length === 0) {
    return "无相关历史记录";
  }

  // 查找同一文档的所有相关记忆
  var relevantMemories: string[] = [];
  
  for (var i = memories.length - 1; i >= 0; i--) {
    var mem = memories[i];
    if (mem.docPath !== docPath) continue;

    // 检查是否与当前用户输入相关
    var isRelated = false;
    if (mem.userInput === userInput) {
      isRelated = true;
    } else {
      // 检查关键字重叠
      var keywords = userInput.split(/[\s,，、]/).filter(k => k.length > 1);
      for (var j = 0; j < keywords.length; j++) {
        if (mem.userInput.indexOf(keywords[j]) >= 0 || mem.errorMessage.indexOf(keywords[j]) >= 0) {
          isRelated = true;
          break;
        }
      }
    }

    if (isRelated) {
      var historyEntry = formatMemoryHistory(mem, i);
      relevantMemories.push(historyEntry);
    }
  }

  if (relevantMemories.length === 0) {
    return "无相关历史记录";
  }

  // 返回最近的3条历史记录
  return relevantMemories.slice(0, 3).join("\n\n--- ---\n\n");
}

/**
 * 格式化记忆为可读历史
 */
function formatMemoryHistory(mem: any, index: number): string {
  var lines = [
    `【第 ${mem.retryCount + 1} 次尝试】`,
    `需求: ${mem.userInput}`,
    `结果: ${mem.result}`,
  ];

  if (mem.errorMessage) {
    lines.push(`失败原因: ${mem.errorMessage}`);
  }

  if (mem.failedSteps && mem.failedSteps.length > 0) {
    lines.push(`失败步骤: ${mem.failedSteps.join(", ")}`);
  }

  if (mem.plan?.steps?.length > 0) {
    lines.push(`执行计划: ${JSON.stringify(mem.plan.steps.map((s: any) => s.action))}`);
  }

  if (mem.result.indexOf("成功") >= 0 && mem.plan?.steps) {
    lines.push(`有效方案: ${JSON.stringify(mem.plan.steps)}`);
  }

  return lines.join("\n");
}

/**
 * 管理记忆
 * 在每次重试/执行后调用
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
  // 提取错误信息
  var errorMessage = extractErrorMessage(executionLog, result);

  // 移除同一需求的旧记忆（保留成功的）
  memories = memories.filter(mem => {
    if (mem.docPath !== docPath || mem.userInput !== userInput) return true;
    if (result.indexOf("成功") >= 0) return false; // 新的成功记录替换旧的
    return false; // 新的失败记录替换旧的
  });

  // 添加新记忆
  var newMemory = {
    docPath,
    userInput,
    retryCount,
    result,
    actions: analysis?.actions || [],
    plan,
    failedSteps,
    errorMessage,
    timestamp: Date.now(),
  };

  memories.push(newMemory);

  // 限制记忆数量
  if (memories.length > MAX_MEMORIES) {
    memories = memories.slice(-MAX_MEMORIES);
  }

  console.log("[记忆管理] 已记录:", result.substring(0, 50), "| 错误:", errorMessage?.substring(0, 30) || "无");
}

/**
 * 从执行日志和结果中提取错误信息
 */
function extractErrorMessage(executionLog: string, result: string): string {
  // 从执行日志中提取失败信息
  var lines = executionLog.split("\n");
  var errors: string[] = [];
  
  for (var line of lines) {
    if (line.indexOf("失败") >= 0 && line.indexOf("[执行]") >= 0) {
      errors.push(line.replace("[执行]", "").trim());
    }
  }

  if (errors.length > 0) {
    return errors.join("; ");
  }

  // 从验证结果中提取
  if (result.indexOf("失败") >= 0) {
    var match = result.match(/原因[：:](.+)/);
    if (match) return match[1].trim();
  }

  return "";
}

/**
 * 检查是否需要用户介入
 * 返回 true 表示问题无法通过重试解决
 */
export function needsUserIntervention(result: string, errorMessage: string): boolean {
  // 明确的不可重试错误
  var nonRetryablePatterns = [
    "文档不存在",
    "文件不存在", 
    "无法打开",
    "权限不足",
    "不支持",
    "格式错误",
    "内容为空",
    "需要用户提供",
    "无法确定",
  ];

  var checkText = result + " " + errorMessage;
  
  for (var pattern of nonRetryablePatterns) {
    if (checkText.indexOf(pattern) >= 0) {
      return true;
    }
  }

  return false;
}

/**
 * 清除所有记忆
 */
export function clearMemories(): void {
  memories = [];
  console.log("[记忆管理] 已清除所有记忆");
}

/**
 * 获取当前记忆状态（调试用）
 */
export function getMemories() {
  return memories;
}