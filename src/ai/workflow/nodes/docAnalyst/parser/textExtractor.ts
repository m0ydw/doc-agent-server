import type { Document } from "../../../../../services/cliRunner";
import type { TextExtractionResult } from "../types";

type SdkBlock = Record<string, unknown> & {
  nodeId?: string;
  ref?: string;
  handle?: {
    ref?: string;
    nodeId?: string;
  };
};

const TEXT_KEYS = ["text", "fullText", "plainText", "textPreview", "content", "value"];
const CHILD_KEYS = ["children", "paragraphs", "runs", "blocks", "items"];

export interface TextExtractionStrategy {
  name: string;
  extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult>;
}

export function extractSdkText(source: unknown): string {
  return extractSdkTextInternal(source, new Set());
}

function extractSdkTextInternal(source: unknown, seen: Set<object>): string {
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object") return "";
  if (seen.has(source)) return "";
  seen.add(source);

  const record = source as Record<string, unknown>;
  const directText = TEXT_KEYS
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");

  if (directText.length > 0) {
    return directText.join("");
  }

  const childText: string[] = [];
  for (const key of CHILD_KEYS) {
    const child = record[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const text = extractSdkTextInternal(item, seen).trim();
        if (text) childText.push(text);
      }
    } else {
      const text = extractSdkTextInternal(child, seen).trim();
      if (text) childText.push(text);
    }
  }

  return childText.join("\n");
}

function getBlockKey(block: SdkBlock): string | undefined {
  return block.ref || block.handle?.ref || block.nodeId || block.handle?.nodeId;
}

function getBlockNodeId(block: SdkBlock): string | undefined {
  return block.nodeId || block.handle?.nodeId;
}

function buildResult(
  blocks: SdkBlock[],
  method: string,
  confidenceWhenHasText: number,
  confidenceWhenEmpty: number
): TextExtractionResult {
  const refTextMap = new Map<string, string>();
  const nodeRefMap = new Map<string, string>();
  let textCount = 0;

  for (const block of blocks) {
    const key = getBlockKey(block);
    const nodeId = getBlockNodeId(block);
    const text = extractSdkText(block);

    if (nodeId) {
      nodeRefMap.set(nodeId, key || nodeId);
    }

    if (!key) continue;
    refTextMap.set(key, text);
    if (text.trim() !== "") {
      textCount++;
    }
  }

  const coverage = blocks.length > 0 ? textCount / blocks.length : 0;

  return {
    refTextMap,
    nodeRefMap,
    extractionMethod: method,
    confidence: coverage > 0 ? confidenceWhenHasText : confidenceWhenEmpty,
    coverage,
  };
}

export class BlockListStrategy implements TextExtractionStrategy {
  name = "block_list";

  async extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult> {
    const cellBlocks = await doc.blocks.list({
      nodeTypes: ["tableCell"],
      limit: 2000,
      includeText: true,
    } as Record<string, unknown>);

    const blocks = ((cellBlocks as Record<string, unknown>).blocks || []) as SdkBlock[];
    return buildResult(blocks, this.name, 0.85, 0.2);
  }
}

export class QueryMatchStrategy implements TextExtractionStrategy {
  name = "query_match";

  async extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult> {
    const result = await doc.query.match({
      select: { type: "node", nodeType: "tableCell" },
      require: "any",
    });

    const items = ((result as Record<string, unknown>).items || []) as SdkBlock[];
    return buildResult(items, this.name, 0.6, 0.2);
  }
}

export class StructureOnlyStrategy implements TextExtractionStrategy {
  name = "structure_only";

  async extract(doc: Document, tableNodeId: string): Promise<TextExtractionResult> {
    const cellBlocks = await doc.blocks.list({
      nodeTypes: ["tableCell"],
      limit: 2000,
      includeText: true,
    } as Record<string, unknown>);

    const blocks = ((cellBlocks as Record<string, unknown>).blocks || []) as SdkBlock[];
    const result = buildResult(blocks, this.name, 0.5, 0.5);

    return {
      ...result,
      confidence: 0.5,
    };
  }
}

export class CentralizedTextExtractor {
  async extract(
    doc: Document,
    tableNodeId: string,
    isComplexMode: boolean = false
  ): Promise<TextExtractionResult> {
    const blockStrategy = new BlockListStrategy();
    const blockResult = await blockStrategy.extract(doc, tableNodeId);

    if (
      blockResult.coverage >= 0.7 ||
      (blockResult.coverage >= 0.4 && blockResult.confidence >= 0.8)
    ) {
      return blockResult;
    }

    if (isComplexMode || blockResult.coverage < 0.3) {
      const queryStrategy = new QueryMatchStrategy();
      const queryResult = await queryStrategy.extract(doc, tableNodeId);

      if (queryResult.coverage > blockResult.coverage) {
        return queryResult;
      }
    }

    const structureStrategy = new StructureOnlyStrategy();
    return structureStrategy.extract(doc, tableNodeId);
  }
}
