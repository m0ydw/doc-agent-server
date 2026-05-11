/**
 * DocAnalyst（文档考古学家）节点
 *
 * 职责：
 *   1. 读取文档结构（readTable）
 *   2. 定位标签单元格（findCell）
 *   3. 微决策：确定每个标签对应的目标写入格（getTargetCell）
 *   4. 产出 DocumentMap
 *
 * 工具集（只读）：
 *   - sdk_read_table
 *   - sdk_find_cell
 *   - sdk_get_text（仅结构验证）
 *
 * LLM 角色：仅用于微决策（判断目标格位置）
 */

import { ChatOpenAI } from "@langchain/openai";
import { StructuredTool } from "@langchain/core/tools";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../state";
import { ALL_LABELS } from "../../modules/fieldConfig";
import * as editor from "../../../services/editor";

// ================================================================
// 类型定义
// ================================================================

export interface CellInfo {
  row: number;
  col: number;
  ref: string;
  text: string;
}

export interface TargetCellResult {
  targetRow: number;
  targetCol: number;
  targetRef: string;
  confidence: "high" | "medium" | "low";
}

export interface LabelMapping {
  label: string;
  labelCell: CellInfo;
  suggestedTarget: TargetCellResult;
}

export interface AnalyzedTable {
  index: number;
  rows: number;
  cols: number;
  cells: CellInfo[];
  labels: LabelMapping[];
}

export interface DocumentMap {
  docId: string;
  docName: string;
  tables: AnalyzedTable[];
}

// ================================================================
// 微决策工具
// ================================================================

interface NeighborCells {
  right?: { row: number; col: number; ref: string; text: string } | null;
  rightNext?: { row: number; col: number; ref: string; text: string } | null;
  down?: { row: number; col: number; ref: string; text: string } | null;
}

async function getSurroundingCells(
  docId: string,
  cells: CellInfo[],
  sourceRow: number,
  sourceCol: number,
): Promise<NeighborCells> {
  const find = (r: number, c: number) => cells.find((cell) => cell.row === r && cell.col === c);

  const getText = async (cell: CellInfo | undefined): Promise<CellInfo | null> => {
    if (!cell) return null;
    try {
      // 通过 findCell 获取该位置的文本内容
      const result = await editor.findCell(docId, cell.text || "");
      // 如果找不到，返回基本信息
      return { ...cell, text: cell.text || "" };
    } catch {
      return cell;
    }
  };

  const right = find(sourceRow, sourceCol + 1);
  const rightNext = find(sourceRow, sourceCol + 2);
  const down = find(sourceRow + 1, sourceCol);

  return {
    right: right ? { row: right.row, col: right.col, ref: right.ref, text: right.text } : null,
    rightNext: rightNext ? { row: rightNext.row, col: rightNext.col, ref: rightNext.ref, text: rightNext.text } : null,
    down: down ? { row: down.row, col: down.col, ref: down.ref, text: down.text } : null,
  };
}

/**
 * LLM 微决策：从标签格四周推断目标写入格
 */
async function microDecideTargetCell(
  llm: ChatOpenAI,
  labelName: string,
  labelCell: CellInfo,
  surroundings: NeighborCells,
): Promise<TargetCellResult> {
  const prompt = `【目标单元格定位】
标签 "${labelName}" 位于坐标 (${labelCell.row}, ${labelCell.col})，ref="${labelCell.ref.slice(0, 16)}..."。

其相邻单元格信息：
- 右侧 (${labelCell.row}, ${labelCell.col + 1}): ${surroundings.right ? `text="${surroundings.right.text}"` : "无"}
${surroundings.rightNext ? `- 右2格 (${labelCell.row}, ${labelCell.col + 2}): text="${surroundings.rightNext.text}"` : ""}
- 下方 (${labelCell.row + 1}, ${labelCell.col}): ${surroundings.down ? `text="${surroundings.down.text}"` : "无"}

表格是典型的横向布局（标签在左，值在右）。
请判断哪个单元格是 "${labelName}" 对应的待填值目标格。

【输出要求】
只输出 JSON：{"targetRow": 数字, "targetCol": 数字, "targetRef": "字符串", "confidence": "high|medium|low"}
不要包含任何解释文字。`;

  try {
    const response = await llm.invoke([
      new SystemMessage("你是表格结构分析专家。只输出JSON，不解释。"),
      new HumanMessage(prompt),
    ]);

    const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as TargetCellResult;
    }
  } catch (err) {
    console.warn("[DocAnalyst] 微决策 LLM 调用失败:", (err as Error).message);
  }

  // 降级：默认取右侧第一格
  const fallback = surroundings.right;
  return {
    targetRow: fallback ? fallback.row : labelCell.row,
    targetCol: fallback ? fallback.col : labelCell.col + 1,
    targetRef: fallback ? fallback.ref : labelCell.ref,
    confidence: "low",
  };
}

// ================================================================
// 主节点实现
// ================================================================

export function createDocAnalystNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const documentMaps: DocumentMap[] = [];
    const logs: string[] = [];

    try {
      // 1. 读取表格结构
      const tableJson = await editor.readTable(docId, 0);
      const tableData = JSON.parse(tableJson);

      if (tableData.error) {
        logs.push(`[DocAnalyst] 读取表格失败: ${tableData.error}`);
        // 尝试使用 getStructure 作为备用
        const structureJson = await editor.getStructure(docId);
        logs.push(`[DocAnalyst] 使用备用结构: ${structureJson.slice(0, 200)}`);
      }

      // 2. 构建 CellInfo 列表
      const cells: CellInfo[] = (tableData.cells || []).map((c: Record<string, unknown>) => ({
        row: c.row as number,
        col: c.col as number,
        ref: (c.ref as string) || "",
        text: "",
      }));

      // 3. 检测标签：查找表格中包含常见标签文字的单元格
      const labels: LabelMapping[] = [];
      for (const labelName of ALL_LABELS) {
        try {
          const findResult = await editor.findCell(docId, labelName);
          if (findResult && !findResult.startsWith("未找到")) {
            // 解析 findCell 返回结果，提取 ref
            const refMatch = findResult.match(/ref=(\S+)/);
            if (refMatch) {
              const foundRef = refMatch[1];
              // 在 cells 中查找对应的行/列
              const cell = cells.find((c) => c.ref === foundRef || foundRef.startsWith(c.ref));
              if (cell) {
                const labelCell: CellInfo = { ...cell, text: labelName };

                // 4. 微决策：确定目标格
                const surroundings = await getSurroundingCells(docId, cells, cell.row, cell.col);
                const target = await microDecideTargetCell(llm, labelName, labelCell, surroundings);

                labels.push({ label: labelName, labelCell, suggestedTarget: target });
                logs.push(`[DocAnalyst] 找到标签 "${labelName}" → 目标格 (${target.targetRow},${target.targetCol}) 置信度: ${target.confidence}`);
              }
            }
          }
        } catch (err) {
          // 标签查找失败，跳过
        }
      }

      documentMaps.push({
        docId,
        docName: state.targetDocName || docId,
        tables: [{
          index: 0,
          rows: tableData.rows || 0,
          cols: tableData.cols || 0,
          cells,
          labels,
        }],
      });

      logs.push(`[DocAnalyst] 分析完成: ${labels.length} 个标签, ${cells.length} 个单元格`);
    } catch (err) {
      logs.push(`[DocAnalyst] 分析异常: ${(err as Error).message}`);
    }

    return {
      documentMaps: JSON.stringify(documentMaps),
      executionLog: logs.join("\n"),
      delegationStep: (state.delegationStep ?? 0) + 1,
      lastAgent: "DocAnalyst",
    };
  };
}
