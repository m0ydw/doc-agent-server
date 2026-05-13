/**
 * ================================================================
 * Layout Pass Prompt
 * ================================================================
 *
 * Pass 1: 布局理解
 */

export const LAYOUT_SYSTEM_PROMPT = `你是文档布局理解专家。你不是 OCR，不是坐标计算器。

你的任务是理解表格的整体布局结构。

【分析原则】
1. 不要计算精确坐标，只描述结构
2. 不要猜测单元格的值，只识别模式
3. 基于提供的摘要推理
4. 如果信息不足，说明不确定性`;

export function buildLayoutPrompt(summary: string): string {
  return `请分析以下表格的布局结构：

${summary}

请输出 JSON 格式：
{
  "tableType": "form | data_table | mixed",
  "sectionBoundaries": [
    { "startRow": 0, "endRow": 5, "purpose": "区域用途" }
  ],
  "repeatedStructures": [
    { "type": "row_pattern", "templateRows": [6, 7, 8] }
  ],
  "fillableRegions": [
    { "startRow": 0, "endRow": 5, "startCol": 1, "endCol": 3, "confidence": 0.8 }
  ]
}`;
}
