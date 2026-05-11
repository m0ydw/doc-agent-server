/**
 * TemplateFiller（重型填表专员）节点
 *
 * 职责：执行模板数据填充任务
 *
 * 内部确定性流水线：
 *   DataExtractor → TemplateMapper → BatchWrite(DataGuard硬拦截)
 *
 * 特点：完全确定性执行，不含 LLM 决策。
 *       LLM 决策已在 DocAnalyst（微决策）阶段完成。
 *       用完即弃：执行完毕后防御状态自动释放。
 *
 * 工具集：
 *   - sdk_set_text（唯一对外工具，内部含 DataGuard 拦截）
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "../state";
import * as editor from "../../../services/editor";
import { DataGuard } from "../../modules/dataGuard";
import {
  buildFieldMappings,
  allMappingsDone,
  getMappingStats,
  type FieldMapping,
} from "../../modules/templateMapper";
import type { DocumentMap } from "./docAnalyst";

// ================================================================
// 主节点实现（纯确定性，无 LLM 调用）
// ================================================================

export function createTemplateFillerNode() {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const logs: string[] = [];

    try {
      // 1. 解析输入数据
      let extractedData: Record<string, string> = {};
      let documentMaps: DocumentMap[] = [];
      let existingMappings: FieldMapping[] = [];

      try {
        extractedData = JSON.parse(state.extractedData || "{}");
        documentMaps = JSON.parse(state.documentMaps || "[]");
        existingMappings = JSON.parse(state.fieldMappings || "[]");
      } catch {
        logs.push("[TemplateFiller] 输入数据解析失败，尝试从用户原始输入中提取");
      }

      // 确定目标文档的 DocumentMap
      const targetMap = documentMaps.find((m) => m.docId === docId) || documentMaps[0];
      if (!targetMap) {
        logs.push("[TemplateFiller] 未找到目标文档的 DocumentMap，无法执行填充");
        return {
          executionLog: state.executionLog + "\n" + logs.join("\n"),
          delegationStep: (state.delegationStep ?? 0) + 1,
          success: false,
          lastAgent: "TemplateFiller",
        };
      }

      // 2. 如果已有映射表（来自之前的执行），使用它；否则重新构建
      let mappings = existingMappings;
      if (mappings.length === 0 && extractedData && Object.keys(extractedData).length > 0) {
        const result = buildFieldMappings(targetMap, extractedData);
        mappings = result.mappings;
        logs.push(`[TemplateFiller] 映射构建完成: ${result.summary.matched}/${result.summary.total} 字段已匹配`);
        if (result.summary.unmatchedFields.length > 0) {
          logs.push(`[TemplateFiller] 未匹配字段: ${result.summary.unmatchedFields.join(", ")}`);
        }
      }

      if (mappings.length === 0) {
        logs.push("[TemplateFiller] 没有可写入的字段映射");
        return {
          executionLog: state.executionLog + "\n" + logs.join("\n"),
          fieldMappings: "[]",
          delegationStep: (state.delegationStep ?? 0) + 1,
          success: false,
          lastAgent: "TemplateFiller",
        };
      }

      // 3. 装载 DataGuard
      DataGuard.arm(extractedData);
      logs.push(`[TemplateFiller] DataGuard 已装载，允许值: ${DataGuard.getAllowedValues().join(", ")}`);

      // 4. 批量写入（确定性执行）
      let writtenCount = 0;
      let blockedCount = 0;
      let failedCount = 0;

      for (const mapping of mappings) {
        if (mapping.status === "written") continue; // 已写入，跳过

        const targetRef = mapping.targetCell.ref;
        if (!targetRef) {
          mapping.status = "failed";
          mapping.errorReason = "目标格 ref 为空";
          failedCount++;
          continue;
        }

        // DataGuard 硬拦截
        const guardResult = DataGuard.guard(mapping.userValue);
        if (!guardResult.allowed) {
          mapping.status = "blocked";
          mapping.errorReason = guardResult.reason;
          blockedCount++;
          logs.push(`[DataGuard] ${guardResult.reason}`);
          continue;
        }

        // 写入
        try {
          const result = await editor.setText(docId, targetRef, mapping.userValue);
          mapping.status = "written";
          writtenCount++;
          logs.push(`[TemplateFiller] ${mapping.fieldName} → ${result}`);

        } catch (err: unknown) {
          mapping.status = "failed";
          mapping.errorReason = (err as Error).message;
          failedCount++;
          logs.push(`[TemplateFiller] ${mapping.fieldName} 写入失败: ${(err as Error).message}`);

        }
      }

      // 5. 释放 DataGuard
      DataGuard.disarm();

      const stats = getMappingStats(mappings);
      logs.push(
        `[TemplateFiller] 填充完成: ${stats.written} 写入, ${stats.blocked} 拦截, ` +
        `${stats.failed} 失败, ${stats.pending} 待处理`
      );

      return {
        executionLog: state.executionLog + "\n" + logs.join("\n"),
        fieldMappings: JSON.stringify(mappings),
        delegationStep: (state.delegationStep ?? 0) + 1,
        success: failedCount === 0 && blockedCount === 0,
        lastAgent: "TemplateFiller",
      };

    } catch (err: unknown) {
      DataGuard.disarm(); // 确保释放
      logs.push(`[TemplateFiller] 异常: ${(err as Error).message}`);
      return {
        executionLog: state.executionLog + "\n" + logs.join("\n"),
        delegationStep: (state.delegationStep ?? 0) + 1,
        success: false,
        lastAgent: "TemplateFiller",
      };
    }
  };
}
