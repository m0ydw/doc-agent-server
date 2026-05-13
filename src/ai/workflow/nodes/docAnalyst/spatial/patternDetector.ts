/**
 * ================================================================
 * 重复模式检测器
 * ================================================================
 *
 * 检测表格中的重复行模式
 */

import type { LayoutNode, RepeatedPattern, RawCell } from "../types";

/**
 * 检测重复行模式
 *
 * 策略：比较相邻行的结构相似度
 */
export function detectRepeatedPatterns(
  nodes: LayoutNode[],
  cells: RawCell[],
  rows: number,
  cols: number
): RepeatedPattern[] {
  const patterns: RepeatedPattern[] = [];

  // 按行分组
  const rowMap = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    if (!rowMap.has(node.row)) {
      rowMap.set(node.row, []);
    }
    rowMap.get(node.row)!.push(node);
  }

  // 分析行结构
  const rowStructures: Array<{ row: number; structure: number[] }> = [];
  for (const [row, rowNodes] of rowMap) {
    // 结构 = 每列是否有内容（1 = 有内容，0 = 空）
    const structure = Array(cols).fill(0);
    for (const node of rowNodes) {
      if (node.text && node.text.trim() !== "" && node.text !== "[TEXT_UNAVAILABLE]") {
        structure[node.col] = 1;
      }
    }
    if (structure.every(value => value === 0)) {
      continue;
    }
    rowStructures.push({ row, structure });
  }

  // 查找重复模式
  if (rowStructures.length < 2) {
    return patterns;
  }

  // 使用滑动窗口查找重复模式
  for (let windowSize = 1; windowSize <= Math.floor(rowStructures.length / 2); windowSize++) {
    const patternGroups = new Map<string, number[]>();

    for (let i = 0; i <= rowStructures.length - windowSize; i++) {
      const windowRows = rowStructures.slice(i, i + windowSize);
      const patternKey = windowRows.map(r => r.structure.join(",")).join("|");
      if (windowRows.every(row => row.structure.every(value => value === 0))) {
        continue;
      }

      if (!patternGroups.has(patternKey)) {
        patternGroups.set(patternKey, []);
      }
      patternGroups.get(patternKey)!.push(windowRows[0].row);
    }

    // 找到重复的模式
    for (const [patternKey, occurrences] of patternGroups) {
      if (occurrences.length >= 2) {
        const templateRows = rowStructures
          .filter(row => occurrences[0] <= row.row && row.row < occurrences[0] + windowSize)
          .map(r => r.row);

        patterns.push({
          type: "row_pattern",
          templateRows,
          occurrences,
          nodeIds: occurrences.map(startRow => {
            return nodes
              .filter(n => n.row >= startRow && n.row < startRow + windowSize)
              .map(n => n.id);
          }),
        });
      }
    }
  }

  // 去重（保留最长的模式）
  return deduplicatePatterns(patterns);
}

/**
 * 去重模式
 */
function deduplicatePatterns(patterns: RepeatedPattern[]): RepeatedPattern[] {
  if (patterns.length <= 1) {
    return patterns;
  }

  // 按模式长度降序排序
  patterns.sort((a, b) => b.templateRows.length - a.templateRows.length);

  const result: RepeatedPattern[] = [];
  const usedRows = new Set<number>();

  for (const pattern of patterns) {
    // 检查是否与已使用的行重叠
    const hasOverlap = pattern.occurrences.some(row =>
      pattern.templateRows.some(templateRow =>
        usedRows.has(row + templateRow - pattern.templateRows[0])
      )
    );

    if (!hasOverlap) {
      result.push(pattern);
      // 标记使用的行
      for (const row of pattern.occurrences) {
        for (let i = 0; i < pattern.templateRows.length; i++) {
          usedRows.add(row + i);
        }
      }
    }
  }

  return result;
}
