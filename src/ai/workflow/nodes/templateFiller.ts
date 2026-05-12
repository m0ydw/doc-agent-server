/**
 * TemplateFiller（重型填表专员）节点
 *
 * 职责：执行模板数据填充任务（批量写入表单数据到文档）
 *
 * 【内部确定性流水线】（不含 LLM 决策）
 *   DataExtractor → TemplateMapper → BatchWrite(DataGuard 硬拦截)
 *
 * 【为什么是纯确定性的？】
 * LLM 决策已在 DocAnalyst（微决策确定目标格）阶段完成。
 * TemplateFiller 只需按照已确定的映射表机械执行：
 *   for each fieldMapping:
 *     if DataGuard.guard(value) → editor.setText(ref, value)
 * 无需 LLM 参与判断。
 *
 * 【DataGuard 安全机制】
 * 写入前每个值都必须通过 DataGuard.guard() 检查，防止：
 * - 写入不存在的值
 * - 写入越界数据
 * - 写入格式错误的值
 *
 * 【用完即弃模式】
 * 执行完毕后调用 DataGuard.disarm() 释放防御状态。
 * 异常路径也通过 finally / catch 保证 release。
 *
 * 【在整体流程中的位置】
 * 由 supervisorRouter 根据 agentPlan 调度。通常跟在 docAnalyst 之后、
 * reviewer 之前，三者形成 "分析 → 填充 → 验证" 流水线。
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
//
// 执行流程：
// 1. 解析输入数据（extractedData + documentMaps + fieldMappings）
// 2. 如果无已有映射表 → 调用 templateMapper.buildFieldMappings 构建
// 3. 装载 DataGuard（设置允许写入的值白名单）
// 4. 遍历所有 mapping，对每个条目：
//    - 检查是否已写入（跳过）
//    - DataGuard.guard() 拦截非法写入
//    - editor.setText() 执行写入
// 5. 释放 DataGuard
// 6. 返回执行统计
// ================================================================

/**
 * 创建 TemplateFiller 节点函数
 *
 * 注意：此节点不需要 LLM 参数，因为所有逻辑都是确定性的。
 * 与其他 Agent 节点的工厂函数签名不同。
 */
export function createTemplateFillerNode() {
  return async (state: typeof AgentState.State, config?: RunnableConfig) => {
    const docId = state.docId;
    const logs: string[] = [];

    try {
      // 步骤1：解析输入数据（JSON 字符串 → 对象）
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

      // 确定目标文档的 DocumentMap（可能涉及多文档，取当前 docId 对应的那个）
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

      // 步骤2：构建字段映射表（如果已有则复用，否则调用 templateMapper 构建）
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

      // 步骤3：装载 DataGuard（设置写入值白名单，拦截非法数据）
      DataGuard.arm(extractedData);
      logs.push(`[TemplateFiller] DataGuard 已装载，允许值: ${DataGuard.getAllowedValues().join(", ")}`);

      // 步骤4：批量遍历写入（每个映射条目逐一处理）
      let writtenCount = 0;
      let blockedCount = 0;
      let failedCount = 0;

      for (const mapping of mappings) {
        // 已经写入的跳过（支持增量执行/重试）
        if (mapping.status === "written") continue;

        const targetRef = mapping.targetCell.ref;
        if (!targetRef) {
          mapping.status = "failed";
          mapping.errorReason = "目标格 ref 为空";
          failedCount++;
          continue;
        }

        // DataGuard 硬拦截：检查写入值是否在允许列表中
        const guardResult = DataGuard.guard(mapping.userValue);
        if (!guardResult.allowed) {
          mapping.status = "blocked";
          mapping.errorReason = guardResult.reason;
          blockedCount++;
          logs.push(`[DataGuard] ${guardResult.reason}`);
          continue;
        }

        // 写入文档（通过 SDK 的 setText 操作）
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

      // 步骤5：释放 DataGuard（用完即弃，防止状态泄漏到下一个节点）
      DataGuard.disarm();

      // 步骤6：统计结果
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
      // 异常路径也要确保释放 DataGuard（防止状态泄漏）
      DataGuard.disarm();
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
