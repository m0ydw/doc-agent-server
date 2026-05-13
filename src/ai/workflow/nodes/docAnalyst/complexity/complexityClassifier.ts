import type {
  ParsedDocumentPayload,
  LogicalSpatialGraph,
  ComplexityScore,
  AnalysisMode,
} from "../types";

export function classifyComplexity(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph
): ComplexityScore {
  const factors = {
    size: calculateSizeFactor(payload),
    mergedCells: calculateMergedCellFactor(payload),
    sections: graph.sections.length,
    patterns: graph.repeatedPatterns.length,
    emptyRatio: calculateEmptyRatio(payload),
    estimatedTokens: estimateTokens(payload, graph),
  };

  const score = calculateWeightedScore(factors);
  const mode = determineMode(score, factors);

  return { score, mode, factors };
}

function calculateSizeFactor(payload: ParsedDocumentPayload): number {
  const cellCount = payload.tables.reduce((sum, table) => sum + table.rows * table.cols, 0);
  return Math.min(cellCount / 100, 1);
}

function calculateMergedCellFactor(payload: ParsedDocumentPayload): number {
  const cells = payload.tables.flatMap(table => table.cells);
  if (cells.length === 0) return 0;

  const mergedCount = cells.filter(cell => cell.rowspan > 1 || cell.colspan > 1).length;
  return mergedCount / cells.length;
}

function calculateEmptyRatio(payload: ParsedDocumentPayload): number {
  const cells = payload.tables.flatMap(table => table.cells);
  if (cells.length === 0) return 0;

  const emptyCount = cells.filter(
    cell => !cell.text || cell.text.trim() === "" || cell.text === "[TEXT_UNAVAILABLE]"
  ).length;
  return emptyCount / cells.length;
}

function estimateTokens(
  payload: ParsedDocumentPayload,
  graph: LogicalSpatialGraph
): number {
  const cellCount = payload.tables.reduce((sum, table) => sum + table.cells.length, 0);
  return cellCount * 15 + graph.sections.length * 75 + graph.repeatedPatterns.length * 40;
}

function calculateWeightedScore(factors: ComplexityScore["factors"]): number {
  const normalizedTokens = Math.min(factors.estimatedTokens / 5000, 1);

  return (
    factors.size * 0.2 +
    factors.mergedCells * 0.15 +
    Math.min(factors.sections / 5, 1) * 0.25 +
    Math.min(factors.patterns / 3, 1) * 0.2 +
    factors.emptyRatio * 0.1 +
    normalizedTokens * 0.1
  );
}

function determineMode(
  score: number,
  factors: ComplexityScore["factors"]
): AnalysisMode {
  if (factors.sections >= 3 || factors.patterns >= 2 || factors.estimatedTokens > 8000) {
    return "complex";
  }

  if (score < 0.3) return "simple";
  if (score < 0.7) return "standard";
  return "complex";
}

export class TokenBudgetManager {
  private budget: number;
  private used = 0;

  constructor(estimatedTokens: number) {
    this.budget = Math.max(Math.floor(estimatedTokens * 0.8), 2000);
  }

  canAfford(tokens: number): boolean {
    return this.used + tokens <= this.budget;
  }

  consume(tokens: number): void {
    this.used += tokens;
  }

  getRemaining(): number {
    return this.budget - this.used;
  }

  getUsage(): number {
    return this.budget > 0 ? this.used / this.budget : 0;
  }

  compressPrompt(prompt: string, maxTokens: number): string {
    const estimatedTokens = this.estimateTokens(prompt);
    if (estimatedTokens <= maxTokens) return prompt;

    const ratio = maxTokens / estimatedTokens;
    const keepLength = Math.floor(prompt.length * ratio);
    const halfLength = Math.floor(keepLength / 2);

    return `${prompt.slice(0, halfLength)}\n...[truncated]...\n${prompt.slice(prompt.length - halfLength)}`;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
