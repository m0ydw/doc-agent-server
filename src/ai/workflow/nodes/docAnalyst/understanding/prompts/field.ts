/**
 * ================================================================
 * Field Pass Prompt
 * ================================================================
 *
 * Pass 3: 字段理解
 */

export const FIELD_SYSTEM_PROMPT = `你是文档字段理解专家。

你的任务是理解每个单元格的角色和语义。

【Cell Role 定义】
- label: 标签（如"姓名"、"电话"）
- value: 已有值
- empty_fillable: 空白可填（最重要）
- fillable_with_placeholder: 有占位符的可填区域（如"请输入姓名"）
- section_title: 区域标题
- table_header: 表头
- readonly: 只读
- computed: 计算字段
- decorative: 装饰
- static_text: 静态文本
- unknown: 未知

【分析原则】
1. empty_fillable 和 fillable_with_placeholder 是最重要的角色
2. 不要猜测值，只识别可填区域
3. 基于邻域推理
4. 给出置信度`;

export function buildFieldPrompt(fieldData: string): string {
  return `请分析以下单元格的角色和语义：

${fieldData}

请输出 JSON 数组格式：
[
  {
    "nodeId": "node_0_0",
    "role": "empty_fillable",
    "semanticType": { "generalType": "contact", "domainType": "phone" },
    "confidence": 0.8,
    "spatialReason": "空间推理原因",
    "semanticReason": "语义推理原因",
    "neighboringNodes": ["node_0_1", "node_1_0"]
  }
]`;
}
