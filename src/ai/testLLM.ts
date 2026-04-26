/**
 * LLM 测试脚本 - 用于测试 DeepSeek
 */

import { createDeepSeek, ENV_KEYS } from "./core/aiWrapper";
import { createSingleDocAgent } from "./agent/singleAgent";

async function testSingleAgentStream() {
  console.log("=== 测试 DeepSeek 流式输出 ===");

  const apiKey = process.env[ENV_KEYS.DEEPSEEK];
  if (!apiKey) {
    console.error(`错误: 请设置 ${ENV_KEYS.DEEPSEEK} 环境变量`);
    process.exit(1);
  }
  console.log("API Key:", apiKey.substring(0, 10) + "...");

  // 创建 DeepSeek LLM
  const llm = createDeepSeek({
    apiKey: apiKey,
    modelName: "deepseek-chat",
    temperature: 0.1,
    maxRetries: 3,
  });

  // 创建 Agent
  const docId = "test-doc-id";
  const docPath = "test.docx";
  const agent = createSingleDocAgent(llm, docId, docPath);

  console.log("\n--- 测试用例 ---");
  const userInput =
    "请对文档进行以下操作：1. 将所有'示例'文本加粗；2. 将所有'重要'文本设置为红色；3. 将所有'旧文本'替换为'新文本'；4. 保存文档";
  console.log("用户输入:", userInput);
  console.log("\n开始执行...\n");

  const stream = agent.streamRun(userInput);
  for await (const chunk of stream) {
    process.stdout.write(chunk);
  }

  console.log("\n=== 测试完成 ===");
}

if (require.main === module) {
  testSingleAgentStream().catch(console.error);
}
