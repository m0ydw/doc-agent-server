/**
 * ================================================================
 * Section Pass Prompt
 * ================================================================
 *
 * Pass 2: 区域理解
 */

export const SECTION_SYSTEM_PROMPT = `你是文档区域理解专家。

你的任务是理解单个区域的语义结构。

【分析原则】
1. empty_fillable 是最重要的角色
2. 基于空间关系推理
3. 给出置信度
4. 不要猜测值，只识别可填区域`;

export function buildSectionPrompt(sectionData: string): string {
  return `请分析以下区域的语义结构：

${sectionData}

请输出 JSON 格式：
{
  "sectionId": "区域ID",
  "semanticMeaning": "区域的语义含义",
  "fieldGroups": [
    { "name": "字段组名称", "nodeIds": ["node_0_0", "node_0_1"] }
  ],
  "rowPatterns": [
    { "templateRow": 0, "repeatRows": [3, 6], "meaning": "模式含义" }
  ],
  "writableAreas": [
    { "nodeId": "node_0_1", "reason": "原因", "confidence": 0.8 }
  ]
}`;
}
