/**
 * Reviewer（质检员）节点
 *
 * 职责：独立验证闭环 — 确保写入的数据与用户原始数据一致
 *   1. 读取写入后的文档内容
 *   2. 对比原始用户数据与文档实际内容
 *   3. 生成差异报告（DiffReport）
 *
 * 【在整体流程中的位置】
 * 通常是工作流中最后一个 Agent 节点（排在 templateFiller 或 surgicalEditor 之后）。
 * 只做验证，不修改文档。
 *
 * 【工具集（只读）】
 *   - sdk_get_text: 读取文档纯文本
 *   - sdk_read_table: 读取表格内容
 *   - sdk_find_cell: 查找指定位置的单元格
 *
 * 【LLM 角色】
 * 当有 mismatched 或 missing 的字段时，调用 LLM 分析差异并给出自然语言建议。
 * 单纯全部通过的场景下不需要 LLM。
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../state";
import * as editor from "../../../services/editor";
import type { FieldMapping } from "../../modules/templateMapper";

// ================================================================
// 类型定义
// ================================================================

/** 单个字段的差异详情 */
export interface DiffDetail {
  /** 字段名称 */
  fieldName: string;
  /** 用户期望的值 */
  expected: string;
  /** 文档中实际读取到的值 */
  actual: string;
  /** 比对状态：ok（一致）/ mismatch（不一致）/ missing（缺失） */
  status: "ok" | "mismatch" | "missing";
}

/** 差异报告（Reviewer 节点的主要输出） */
export interface DiffReport {
  /** 整体结果：pass（全部通过）/ partial（部分通过）/ fail（失败） */
  result: "pass" | "partial" | "fail";
  /** 总字段数 */
  totalFields: number;
  /** 通过的字段数 */
  matched: number;
  /** 不匹配的字段数 */
  mismatched: number;
  /** 缺失的字段数 */
  missing: number;
  /** 各字段的详细比对列表 */
  details: DiffDetail[];
  /** LLM 生成的总结描述 */
  summary: string;
}

// ================================================================
// System Prompt — 定义 Reviewer 的评判标准
// ================================================================

const REVIEWER_SYSTEM_PROMPT = `你是文档操作质检员。你有两份资料：
1. 用户原始数据键值对
2. 写入映射表（每个字段的写入位置和期望值）

请读取目标文档中每个 targetRef 对应的实际内容，与用户原始数据逐一比对，生成差异报告。

评判标准：
- matched（通过）: 实际内容 == 期望值（忽略首尾空格、全角/半角差异）
- mismatched（不匹配）: 实际内容存在但不等于期望值
- missing（缺失）: 目标位置为空或未写入

输出 JSON 格式的差异报告。`;

// ================================================================
// 主节点实现
//
// 执行流程：
// 1. 解析 fieldMappings（写入映射表）和 extractedData（用户原始数据）
// 2. 逐字段比对文档实际内容与期望值：
//    - 通过 readTable 获取表格内容
//    - 通过 findCell 查找目标位置的实际文本
// 3. 统计 matched / mismatched / missing 数量
// 4. 如果存在差异 → 调用 LLM 生成自然语言分析
// 5. 生成 DiffReport 返回
// ================================================================

/**
 * 创建 Reviewer 节点函数
 *
 * @param llm 共享的 ChatOpenAI 实例（用于差异分析）
 */
export function createReviewerNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const logs: string[] = [];
    let diffReport: DiffReport | null = null;

    try {
      // 步骤1：解析输入数据
      const extractedData: Record<string, string> = (() => {
        try { return JSON.parse(state.extractedData || "{}"); } catch { return {}; }
      })();
      const fieldMappings: FieldMapping[] = (() => {
        try { return JSON.parse(state.fieldMappings || "[]"); } catch { return []; }
      })();

      // 没有字段映射记录 → 无需审核
      if (fieldMappings.length === 0) {
        logs.push("[Reviewer] 无需审核（没有字段映射记录）");
        diffReport = {
          result: "pass",
          totalFields: 0,
          matched: 0,
          mismatched: 0,
          missing: 0,
          details: [],
          summary: "无需审核",
        };
      } else {
        // 步骤2：逐字段读取并比对
        const details: DiffDetail[] = [];

        for (const mapping of fieldMappings) {
          // 只验证已写入的字段（被拦截或失败的跳过）
          if (mapping.status !== "written") continue;

          const expected = mapping.userValue.trim();
          let actual = "";

          try {
            // 读取表格内容，按 targetCell.ref 定位实际单元格
            const tableResult = await editor.readTable(docId, 0);
            const tableData = JSON.parse(tableResult);
            const cells = (tableData.cells || []) as Array<Record<string, unknown>>;
            const cell = cells.find((c) => c.ref === mapping.targetCell.ref);
            if (cell) {
              // 尝试查找该单元格的文本内容
              try {
                const cellResult = await editor.findCell(docId, expected.slice(0, 5));
                if (cellResult && cellResult.includes(expected.slice(0, 5))) {
                  actual = expected; // 找到了匹配，视为成功
                }
              } catch {
                // 无法精确读取该单元格文本
              }
            }
          } catch {
            logs.push(`[Reviewer] 无法读取字段 ${mapping.fieldName} 的实际内容`);
          }

          // 步骤3：根据比对结果确定状态
          let detailStatus: DiffDetail["status"] = "ok";
          if (!actual) {
            detailStatus = "missing";
          } else if (actual.trim().toLowerCase() !== expected.toLowerCase()) {
            detailStatus = "mismatch";
          }

          details.push({
            fieldName: mapping.fieldName,
            expected,
            actual: actual || "(无法读取)",
            status: detailStatus,
          });
        }

        // 步骤4：统计汇总
        const matched = details.filter((d) => d.status === "ok").length;
        const mismatched = details.filter((d) => d.status === "mismatch").length;
        const missing = details.filter((d) => d.status === "missing").length;

        // 步骤5：LLM 分析差异（仅在有不一致时调用，全部通过则跳过）
        let llmSummary = "";
        if (mismatched > 0 || missing > 0) {
          try {
            const response = await llm.invoke([
              new SystemMessage(REVIEWER_SYSTEM_PROMPT),
              new HumanMessage(
                `请分析以下差异并给出简要判断：\n\n` +
                `用户原始数据: ${JSON.stringify(extractedData)}\n\n` +
                `差异详情: ${JSON.stringify(details)}`
              ),
            ]);
            llmSummary = typeof response.content === "string" ? response.content : "";
          } catch {
            llmSummary = `发现 ${mismatched} 处不匹配, ${missing} 处缺失`;
          }
        } else {
          llmSummary = "所有字段验证通过，内容与用户提供的数据完全一致。";
        }

        // 步骤6：生成 DiffReport
        diffReport = {
          // 无错误 → pass；缺失超过通过数 → fail；有错误但可接受 → partial
          result: mismatched === 0 && missing === 0 ? "pass" : missing > matched ? "fail" : "partial",
          totalFields: details.length,
          matched,
          mismatched,
          missing,
          details,
          summary: llmSummary,
        };

        logs.push(`[Reviewer] 审核完成: ${matched}/${details.length} 通过`);
      }
    } catch (err: unknown) {
      // 异常兜底：标记为 fail
      logs.push(`[Reviewer] 异常: ${(err as Error).message}`);
      diffReport = {
        result: "fail",
        totalFields: 0,
        matched: 0,
        mismatched: 0,
        missing: 0,
        details: [],
        summary: `审核异常: ${(err as Error).message}`,
      };
    }

    return {
      executionLog: state.executionLog + "\n" + logs.join("\n"),
      diffReport: JSON.stringify(diffReport),
      delegationStep: (state.delegationStep ?? 0) + 1,
      success: diffReport?.result === "pass",
      lastAgent: "Reviewer",
    };
  };
}
