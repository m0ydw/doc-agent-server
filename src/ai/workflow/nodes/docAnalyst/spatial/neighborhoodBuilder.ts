/**
 * ================================================================
 * 邻域模型构建器（O(1) 优化）
 * ================================================================
 *
 * 预构建 nodeMap 和 adjacencyMap，所有查询 O(1)
 */

import type { LayoutNode, LayoutEdge, Section, CellNeighborhood } from "../types";

/**
 * 构建邻域模型
 */
export function buildNeighborhoods(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  sections: Section[]
): Map<string, CellNeighborhood> {
  // 预构建索引，O(n)
  const nodeMap = new Map<string, LayoutNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // 预构建 section 索引
  const sectionMap = new Map<string, Section>();
  for (const section of sections) {
    for (const nodeId of section.nodeIds) {
      sectionMap.set(nodeId, section);
    }
  }

  // 预构建邻接关系，O(e)
  const adjacencyMap = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacencyMap.has(edge.source)) {
      adjacencyMap.set(edge.source, new Set());
    }
    if (!adjacencyMap.has(edge.target)) {
      adjacencyMap.set(edge.target, new Set());
    }
    adjacencyMap.get(edge.source)!.add(edge.target);
    adjacencyMap.get(edge.target)!.add(edge.source);
  }

  // 构建邻域，O(n)
  const neighborhoods = new Map<string, CellNeighborhood>();

  for (const node of nodes) {
    const neighbors = adjacencyMap.get(node.id) || new Set();
    const section = sectionMap.get(node.id);

    // O(1) 查找方向邻居
    let top: string | undefined;
    let bottom: string | undefined;
    let left: string | undefined;
    let right: string | undefined;

    for (const neighborId of neighbors) {
      const neighbor = nodeMap.get(neighborId);
      if (!neighbor) continue;

      // 垂直邻居
      if (neighbor.col === node.col) {
        if (neighbor.row === node.row - 1) {
          top = neighborId;
        } else if (neighbor.row === node.row + 1) {
          bottom = neighborId;
        }
      }

      // 水平邻居
      if (neighbor.row === node.row) {
        if (neighbor.col === node.col - 1) {
          left = neighborId;
        } else if (neighbor.col === node.col + 1) {
          right = neighborId;
        }
      }
    }

    neighborhoods.set(node.id, {
      nodeId: node.id,
      tableIndex: node.tableIndex,
      top,
      bottom,
      left,
      right,
      nearby: Array.from(neighbors),
      sectionId: section?.id,
    });
  }

  return neighborhoods;
}
