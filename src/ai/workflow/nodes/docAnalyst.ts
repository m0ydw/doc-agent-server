/**
 * DocAnalyst（文档考古学家）节点
 *
 * 职责：
 *   1. 读取文档结构（readTable / getStructure）
 *   2. 定位标签单元格（findCell — 搜索表格中包含已知标签文字的单元格）
 *   3. 微决策：LLM 判断每个标签对应的目标写入格位置（getTargetCell）
 *   4. 产出 DocumentMap（包含表格结构 + 标签映射的完整文档地图）
 *
 * 【在整体流程中的位置】
 * 由 supervisorRouter 根据 agentPlan 调度。通常在其他 Agent 之前执行，
 * 为 surgicalEditor / templateFiller 提供文档的结构化描述。
 *
 * 【工具集（只读）】
 *   - sdk_read_table: 读取表格结构
 *   - sdk_find_cell: 查找指定文本所在的单元格
 *   - sdk_get_text: 仅用于结构验证（不修改文档）
 *
 * 【LLM 角色】仅用于微决策（判断目标写作格位置），不做复杂推理
 * 【为什么微决策需要 LLM？】表格格式多样化（有的标签右侧是值、有的是下方），
 *   规则难以覆盖所有布局，需要 LLM 根据相邻单元格内容做最佳判断。
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
// 类型定义 — DocumentMap 的数据结构
// ================================================================

/** 单元格信息 */
export interface CellInfo {
  /** 行号（0-based） */
  row: number;
  /** 列号（0-based） */
  col: number;
  /** 单元格唯一引用标识（如 "A1", "B3"） */
  ref: string;
  /** 单元格内的文本内容 */
  text: string;
}

/** LLM 微决策返回的目标单元格信息 */
export interface TargetCellResult {
  targetRow: number;
  targetCol: number;
  targetRef: string;
  /** 置信度：high（明确判定）/ medium（有依据但不确定）/ low（降级默认） */
  confidence: "high" | "medium" | "low";
}

/** 标签→目标格的完整映射 */
export interface LabelMapping {
  /** 标签文本（如 "姓名"、"联系电话"） */
  label: string;
  /** 标签所在的单元格信息 */
  labelCell: CellInfo;
  /** LLM 推断的目标写入格 */
  suggestedTarget: TargetCellResult;
}

/** 单个表格的分析结果 */
export interface AnalyzedTable {
  /** 表格在文档中的索引 */
  index: number;
  rows: number;
  cols: number;
  cells: CellInfo[];
  /** 发现的标签映射列表 */
  labels: LabelMapping[];
}

/** 文档的完整分析地图（可能涉及多个文档） */
export interface DocumentMap {
  docId: string;
  docName: string;
  tables: AnalyzedTable[];
}

// ================================================================
// 微决策工具 — 为 LLM 微决策提供上下文数据
//
// 工作流程：
// 1. getSurroundingCells: 获取标签格四周的相邻单元格信息
// 2. microDecideTargetCell: LLM 根据四周信息判断哪个是目标写入格
// ================================================================

/** 标签单元格四周的相邻单元格信息 */
interface NeighborCells {
  /** 右侧单元格 */
  right?: { row: number; col: number; ref: string; text: string } | null;
  /** 右侧第二个单元格（考虑合并单元格场景） */
  rightNext?: { row: number; col: number; ref: string; text: string } | null;
  /** 下方单元格（纵向布局常见） */
  down?: { row: number; col: number; ref: string; text: string } | null;
}

/**
 * 获取指定单元格四周的相邻单元格
 *
 * 通过 cells 数组查找同行/同列偏移的单元格。
 * 只获取 right（右侧1格）、rightNext（右侧2格）、down（下方1格）三个方向。
 *
 * @param docId     文档 ID
 * @param cells     所有单元格列表
 * @param sourceRow 源行号
 * @param sourceCol 源列号
 * @returns 相邻单元格信息
 */
async function getSurroundingCells(
  docId: string,
  cells: CellInfo[],
  sourceRow: number,
  sourceCol: number,
): Promise<NeighborCells> {
  // 在 cells 数组中按行列查找
  const find = (r: number, c: number) => cells.find((cell) => cell.row === r && cell.col === c);

  // getText 函数暂留，未来可改用 SDK 精确读取单元格文本
  const getText = async (cell: CellInfo | undefined): Promise<CellInfo | null> => {
    if (!cell) return null;
    try {
      const result = await editor.findCell(docId, cell.text || "");
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
 *
 * 【为什么需要 LLM 微决策？】
 * 表格格式千变万化，标签和值的相对位置不固定：
 * - 典型横排表格：标签在左，值在右
 * - 竖排表格：标签在上，值在下
 * - 合并单元格场景：标签占多列，值在更远的列
 * 规则引擎难以覆盖所有情况，而 LLM 能根据上下文灵活判断。
 *
 * 【降级策略】
 * 如果 LLM 调用失败，默认取右侧第一格（最常见的横排布局）。
 *
 * @param llm         LLM 实例
 * @param labelName   标签文本
 * @param labelCell   标签单元格信息
 * @param surroundings 相邻单元格信息
 * @returns LLM 判定的目标单元格 + 置信度
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

  // 降级：默认取右侧第一格（最典型布局）
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
//
// 执行流程：
// 1. 调用 editor.readTable(0) 读取第一个表格的完整结构
// 2. 遍历已知标签列表（ALL_LABELS），通过 findCell 定位标签位置
// 3. 对每个找到的标签，获取相邻单元格信息
// 4. 调用 LLM 微决策确定目标写入格
// 5. 组装 DocumentMap 返回
// ================================================================

/**
 * 创建 DocAnalyst 节点函数
 *
 * 这是一个工厂函数，返回符合 LangGraph 节点签名的 async 函数。
 *
 * @param llm 共享的 ChatOpenAI 实例（用于微决策）
 */
export function createDocAnalystNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const documentMaps: DocumentMap[] = [];
    const logs: string[] = [];

    try {
      // 步骤1：读取表格结构（第一个表格，index=0）
      const tableJson = await editor.readTable(docId, 0);
      const tableData = JSON.parse(tableJson);

      // 如果 readTable 失败，尝试使用 getStructure 作为备用
      if (tableData.error) {
        logs.push(`[DocAnalyst] 读取表格失败: ${tableData.error}`);
        const structureJson = await editor.getStructure(docId);
        logs.push(`[DocAnalyst] 使用备用结构: ${structureJson.slice(0, 200)}`);
      }

      // 步骤2：构建 CellInfo 列表（从表格数据中提取行列和 ref）
      const cells: CellInfo[] = (tableData.cells || []).map((c: Record<string, unknown>) => ({
        row: c.row as number,
        col: c.col as number,
        ref: (c.ref as string) || "",
        text: "",
      }));

      // 步骤3：检测标签 — 遍历已知标签列表，在表格中查找对应单元格
      const labels: LabelMapping[] = [];
      for (const labelName of ALL_LABELS) {
        try {
          const findResult = await editor.findCell(docId, labelName);
          if (findResult && !findResult.startsWith("未找到")) {
            // 解析 findCell 返回结果中的 ref（如 "ref=A1"）
            const refMatch = findResult.match(/ref=(\S+)/);
            if (refMatch) {
              const foundRef = refMatch[1];
              // 在 cells 中查找对应的行/列信息
              const cell = cells.find((c) => c.ref === foundRef || foundRef.startsWith(c.ref));
              if (cell) {
                const labelCell: CellInfo = { ...cell, text: labelName };

                // 步骤4：微决策 — 获取相邻单元格并让 LLM 判断目标写入格
                const surroundings = await getSurroundingCells(docId, cells, cell.row, cell.col);
                const target = await microDecideTargetCell(llm, labelName, labelCell, surroundings);

                labels.push({ label: labelName, labelCell, suggestedTarget: target });
                logs.push(`[DocAnalyst] 找到标签 "${labelName}" → 目标格 (${target.targetRow},${target.targetCol}) 置信度: ${target.confidence}`);
              }
            }
          }
        } catch (err) {
          // 标签查找失败，跳过（不阻塞整体流程）
        }
      }

      // 步骤5：组装 DocumentMap
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
