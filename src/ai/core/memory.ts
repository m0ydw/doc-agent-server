/**
 * 记忆管理模块
 */

var memories: string[] = [];

export function retrieveMemory(docPath: string, userInput: string): string {
  for (var i = memories.length - 1; i >= 0; i--) {
    var memory = memories[i];
    if (memory.indexOf(docPath) >= 0) {
      var keywords = userInput.split(" ");
      var found = false;
      for (var j = 0; j < keywords.length; j++) {
        if (memory.indexOf(keywords[j]) >= 0) {
          found = true;
          break;
        }
      }
      if (found) return memory;
    }
  }
  return "无相关历史记录";
}

export function manageMemory(
  docPath: string,
  userInput: string,
  retryCount: number,
  result: string,
  analysis: any,
  plan: any
): void {
  var memoryBase = "文档: " + docPath + " | 需求: " + userInput + " | 重试次数: " + retryCount;

  if (result.indexOf("失败") >= 0 && (result.indexOf("原因是") >= 0 || result.indexOf("未找到") >= 0 || result.indexOf("不支持") >= 0)) {
    memories.push(memoryBase + " | 结果: " + result + " | 分析: " + JSON.stringify(analysis));
  } else if (result.indexOf("成功") >= 0 && retryCount > 0) {
    for (var i = memories.length - 1; i >= 0; i--) {
      if (memories[i].indexOf(docPath) >= 0 && memories[i].indexOf(userInput) >= 0 && memories[i].indexOf("失败") >= 0) {
        memories.splice(i, 1);
      }
    }
    memories.push(memoryBase + " | 结果: " + result + " | 有效方案: " + JSON.stringify(plan));
  }
}

export function clearMemories(): void {
  memories = [];
}