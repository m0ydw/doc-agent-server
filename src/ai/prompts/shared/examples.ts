/**
 * ================================================================
 * Few-shot 示例数据
 * ================================================================
 * 用于 FewShotChatMessagePromptTemplate 或在模板中手动注入。
 * 正反例帮助 LLM 理解正确行为边界。
 */

/**
 * 意图分类正反例 — 解决 "写了什么web软件" 被误判为替换操作
 */
export const CLASSIFICATION_EXAMPLES = {
  correct: [
    {
      input: "这个项目写了一个什么web软件？",
      output: { intent: "content_query", operations: [{ type: "query", goal: "了解项目开发的web软件的具体名称和功能" }] },
    },
    {
      input: "总结文档内容",
      output: { intent: "content_query", operations: [{ type: "query", goal: "总结文档主要内容" }] },
    },
    {
      input: "把文档里的公司全部替换为集团",
      output: { intent: "text_replace", operations: [{ type: "replace", target: "公司", goal: "替换为集团" }] },
    },
  ],
  /** 反例（不要这样做） */
  incorrect: [
    {
      input: "这个项目写了一个什么web软件？",
      wrong: { intent: "text_replace", operations: [{ type: "replace", target: "web软件", goal: "替换为'写了一个什么'" }] },
      reason: "用户是在询问文档内容，不是要修改文档",
    },
    {
      input: "文档里有哪些人名？",
      wrong: { intent: "text_replace", operations: [{ type: "replace", target: "人名", goal: "提取人名" }] },
      reason: "用户想从文档中提取信息，不是修改文档",
    },
  ],
};

/**
 * 执行风格示例 — 展示正确 vs 错误的日志输出
 */
export const EXECUTION_STYLE_EXAMPLES = {
  /** LLM 应该输出的风格 */
  good: [
    "在文档中搜索'公司'，找到 5 处匹配",
    "将所有'公司'替换为'集团'，已完成 5 处替换",
    "在文档中搜索'web软件'，未找到相关内容",
    "已保存文档修改",
    "所有操作已完成",
  ],
  /** LLM 不应该输出的风格 */
  bad: [
    "调用 sdk_find_text({pattern:'公司'}) 返回 5 个结果",
    "task-1 执行成功，sdk_replace_all 返回 code=0",
    "sdk_find_text 失败，error: Pattern not found",
    "调用 sdk_save() 保存文档",
  ],
};
