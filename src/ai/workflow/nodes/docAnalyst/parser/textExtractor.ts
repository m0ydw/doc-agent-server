/**
 * ================================================================
 * 文本提取器（集中式 + 可替换策略）
 * ================================================================
 *
 * 设计原则：
 * - 禁止 N+1 SDK 调用
 * - 一次性批量提取所有文本
 * - 策略模式支持可替换实现
 * - 使用 coverage 指标评估提取质量
 */

import type { Document } from "../../../../../services/cliRunner";
import type { TextExtractionResult } from "../types";

/** 文本提取策略接口 */
export interface TextExtractionStrategy {
  name: string;
  extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult>;
}

/** 策略1: blocks.list + ref 映射 */
export class BlockListStrategy implements TextExtractionStrategy {
  name = "block_list";

  async extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult> {
    // 批量获取所有 tableCell blocks
    const cellBlocks = await doc.blocks.list({
      nodeTypes: ["tableCell"],
      limit: 2000,
    } as Record<string, unknown>);

    const blocks = ((cellBlocks as Record<string, unknown>).blocks || []) as Array<{
      nodeId?: string;
      ref?: string;
      text?: string;
    }>;

    // 构建 nodeRefMap
    const nodeRefMap = new Map<string, string>();
    for (const block of blocks) {
      if (block.nodeId) {
        nodeRefMap.set(block.nodeId, block.ref || block.nodeId);
      }
    }

    // 尝试从 block 获取文本
    const refTextMap = new Map<string, string>();
    let textCount = 0;
    for (const block of blocks) {
      const key = block.ref || block.nodeId;
      if (key) {
        if (block.text && block.text.trim() !== "") {
          refTextMap.set(key, block.text);
          textCount++;
        } else {
          refTextMap.set(key, "");
        }
      }
    }

    const coverage = blocks.length > 0 ? textCount / blocks.length : 0;

    return {
      refTextMap,
      nodeRefMap,
      extractionMethod: this.name,
      confidence: coverage > 0 ? 0.8 : 0.3,
      coverage,
    };
  }
}

/** 策略2: query.match 批量获取（仅 complex mode 或 coverage < 0.3） */
export class QueryMatchStrategy implements TextExtractionStrategy {
  name = "query_match";

  async extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult> {
    const result = await doc.query.match({
      select: { type: "node", nodeType: "tableCell" },
      require: "any",
    });

    const items = ((result as Record<string, unknown>).items || []) as Array<{
      text?: string;
      content?: string;
      handle?: { ref?: string; nodeId?: string };
    }>;

    const refTextMap = new Map<string, string>();
    const nodeRefMap = new Map<string, string>();
    let textCount = 0;

    for (const item of items) {
      const ref = item.handle?.ref;
      const nodeId = item.handle?.nodeId;
      const key = ref || nodeId;
      const text = item.text || item.content || "";

      if (key) {
        if (text.trim() !== "") {
          refTextMap.set(key, text);
          textCount++;
        } else {
          refTextMap.set(key, "");
        }
      }

      if (nodeId) {
        nodeRefMap.set(nodeId, key || nodeId);
      }
    }

    const coverage = items.length > 0 ? textCount / items.length : 0;

    return {
      refTextMap,
      nodeRefMap,
      extractionMethod: this.name,
      confidence: 0.6,
      coverage,
    };
  }
}

/** 策略3: 只获取结构，文本标记为 [TEXT_UNAVAILABLE] */
export class StructureOnlyStrategy implements TextExtractionStrategy {
  name = "structure_only";

  async extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult> {
    const cellBlocks = await doc.blocks.list({
      nodeTypes: ["tableCell"],
      limit: 2000,
    } as Record<string, unknown>);

    const blocks = ((cellBlocks as Record<string, unknown>).blocks || []) as Array<{
      nodeId?: string;
      ref?: string;
    }>;

    const refTextMap = new Map<string, string>();
    const nodeRefMap = new Map<string, string>();

    for (const block of blocks) {
      if (block.nodeId) {
        const key = block.ref || block.nodeId;
        nodeRefMap.set(block.nodeId, key);
        refTextMap.set(key, "");
      }
    }

    return {
      refTextMap,
      nodeRefMap,
      extractionMethod: this.name,
      confidence: 0.5,
      coverage: 0,
    };
  }
}

/** 集中式文本提取器 */
export class CentralizedTextExtractor {
  private strategies: TextExtractionStrategy[] = [
    new BlockListStrategy(),
    new QueryMatchStrategy(),
    new StructureOnlyStrategy(),
  ];

  /**
   * 提取文本
   *
   * 策略选择逻辑：
   * 1. BlockListStrategy: coverage >= 0.7 或 (coverage >= 0.4 且 confidence >= 0.8)
   * 2. QueryMatchStrategy: 仅 complex mode 或 coverage < 0.3
   * 3. StructureOnlyStrategy: fallback
   */
  async extract(
    doc: Document,
    tableNodeId: string,
    isComplexMode: boolean = false
  ): Promise<TextExtractionResult> {
    // 策略1: BlockListStrategy
    const blockStrategy = new BlockListStrategy();
    const blockResult = await blockStrategy.extract(doc, tableNodeId);

    if (
      blockResult.coverage >= 0.7 ||
      (blockResult.coverage >= 0.4 && blockResult.confidence >= 0.8)
    ) {
      return blockResult;
    }

    // 策略2: QueryMatchStrategy（仅 complex mode 或 coverage < 0.3）
    if (isComplexMode || blockResult.coverage < 0.3) {
      const queryStrategy = new QueryMatchStrategy();
      const queryResult = await queryStrategy.extract(doc, tableNodeId);

      if (queryResult.coverage > blockResult.coverage) {
        return queryResult;
      }
    }

    // 策略3: StructureOnlyStrategy（fallback）
    const structureStrategy = new StructureOnlyStrategy();
    return structureStrategy.extract(doc, tableNodeId);
  }
}
