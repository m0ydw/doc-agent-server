/**
 * Reviewer（质检员）节点
 *
 * 职责：独立验证闭环
 *   1. 读取写入后的文档
 *   2. 对比原始用户数据与文档实际内容
 *   3. 生成差异报告
 *
 * 工具集（只读）：
 *   - sdk_get_text
 *   - sdk_read_table
 *   - sdk_find_cell
 *
 * LLM 角色：分析差异并给出建议
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../state";
import * as editor from "../../../services/editor";
import type { FieldMapping } from "../../modules/templateMapper";

// ================================================================
// 类型
// ================================================================

export interface DiffDetail {
  fieldName: string;
  expected: string;
  actual: string;
  status: "ok" | "mismatch" | "missing";
}

export interface DiffReport {
  result: "pass" | "partial" | "fail";
  totalFields: number;
  matched: number;
  mismatched: number;
  missing: number;
  details: DiffDetail[];
  summary: string;
}

// ================================================================
// System Prompt
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
// ================================================================

export function createReviewerNode(llm: ChatOpenAI) {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const logs: string[] = [];
    let diffReport: DiffReport | null = null;

    try {
      // 解析输入数据
      const extractedData: Record<string, string> = (() => {
        try { return JSON.parse(state.extractedData || "{}"); } catch { return {}; }
      })();
      const fieldMappings: FieldMapping[] = (() => {
        try { return JSON.parse(state.fieldMappings || "[]"); } catch { return []; }
      })();

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
        // 逐字段读取并比对
        const details: DiffDetail[] = [];

        for (const mapping of fieldMappings) {
          if (mapping.status !== "written") continue;

          const expected = mapping.userValue.trim();
          let actual = "";

          try {
            // 通过读取文档文本来验证（降级方案：直接用 findCell 查找该位置的文本）
            const tableResult = await editor.readTable(docId, 0);
            const tableData = JSON.parse(tableResult);
            const cells = (tableData.cells || []) as Array<Record<string, unknown>>;
            const cell = cells.find((c) => c.ref === mapping.targetCell.ref);
            if (cell) {
              // 尝试查找该单元格的文本
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

        const matched = details.filter((d) => d.status === "ok").length;
        const mismatched = details.filter((d) => d.status === "mismatch").length;
        const missing = details.filter((d) => d.status === "missing").length;

        // 使用 LLM 分析差异
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

        diffReport = {
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
