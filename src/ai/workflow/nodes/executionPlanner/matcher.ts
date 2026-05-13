import type {
  SemanticDocumentSchema,
  SemanticCell,
  NormalizedUserData,
  CandidateTarget,
  MatchResult,
} from "./types";

export function matchUserDataToCells(
  schema: SemanticDocumentSchema,
  normalizedData: NormalizedUserData
): MatchResult[] {
  return Object.entries(normalizedData).map(([fieldName, userData]) => {
    const candidates = findCandidateTargets(schema, userData.aliases, userData.semanticType)
      .sort((a, b) => b.confidence - a.confidence);
    const bestCandidate = candidates[0];

    return {
      fieldId: fieldName,
      semanticMeaning: userData.value,
      candidates,
      bestCandidate,
      confidence: bestCandidate?.confidence || 0,
    };
  });
}

function findCandidateTargets(
  schema: SemanticDocumentSchema,
  aliases: string[],
  semanticType?: string
): CandidateTarget[] {
  const candidates: CandidateTarget[] = [];

  for (const cell of schema.writableCells) {
    const confidence = calculateMatchConfidence(schema, cell, aliases, semanticType);
    if (confidence <= 0.3) continue;

    candidates.push({
      nodeId: cell.id,
      ref: cell.ref,
      row: cell.row,
      col: cell.col,
      confidence,
      reason: generateMatchReason(schema, cell, aliases, semanticType),
      constraintScores: {},
    });
  }

  return candidates;
}

function calculateMatchConfidence(
  schema: SemanticDocumentSchema,
  cell: SemanticCell,
  aliases: string[],
  semanticType?: string
): number {
  let confidence = 0;

  confidence += checkNeighborMatch(schema, cell, aliases) * 0.5;

  if (semanticType && cell.semanticType.domainType === semanticType) {
    confidence += 0.3;
  }

  confidence += cell.writableConfidence.finalConfidence * 0.2;

  return Math.min(confidence, 1);
}

function checkNeighborMatch(
  schema: SemanticDocumentSchema,
  cell: SemanticCell,
  aliases: string[]
): number {
  const neighbors = [cell.neighborhood.left, cell.neighborhood.top].filter(Boolean) as string[];

  for (const neighborId of neighbors) {
    const neighbor = schema.allCells.find(candidate => candidate.id === neighborId);
    if (neighbor && matchesAliases(neighbor.text, aliases)) {
      return 0.9;
    }
  }

  return 0;
}

function matchesAliases(text: string, aliases: string[]): boolean {
  const lowerText = text.toLowerCase().trim();
  if (!lowerText) return false;

  return aliases.some(alias => {
    const lowerAlias = alias.toLowerCase().trim();
    return lowerText === lowerAlias || lowerText.includes(lowerAlias) || lowerAlias.includes(lowerText);
  });
}

function generateMatchReason(
  schema: SemanticDocumentSchema,
  cell: SemanticCell,
  aliases: string[],
  semanticType?: string
): string {
  const reasons: string[] = [];

  if (checkNeighborMatch(schema, cell, aliases) > 0) {
    reasons.push("neighbor label matched");
  }
  if (semanticType && cell.semanticType.domainType === semanticType) {
    reasons.push("semantic type matched");
  }
  if (cell.writableConfidence.finalConfidence > 0.7) {
    reasons.push("high writable confidence");
  }

  return reasons.join(", ") || "fallback candidate";
}
