import type { TableFillAnalysis } from "./types";

const analyses = new Map<string, TableFillAnalysis>();

export function saveTableFillAnalysis(analysis: TableFillAnalysis): string {
  analyses.set(analysis.analysisId, analysis);
  return analysis.analysisId;
}

export function getTableFillAnalysis(analysisId: string): TableFillAnalysis | undefined {
  return analyses.get(analysisId);
}
