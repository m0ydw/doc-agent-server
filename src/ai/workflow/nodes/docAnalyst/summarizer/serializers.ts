// layoutSerializer.ts
import { type StructuralSummary } from "../types";
export function serializeLayoutSummary(summary: StructuralSummary): string {
  return `
  Table Type: ${summary.layout.tableType}
  Dimensions: ${summary.layout.dimensions.rows}x${
    summary.layout.dimensions.cols
  }
  
  Sections:
  ${summary.sections
    .slice(0, 8)
    .map(
      (s, i) => `
  [${i}]
  Size: ${s.dimensions.rows}x${s.dimensions.cols}
  Labels: ${s.labelCount}
  Description: ${truncate(s.description, 120)}
  `
    )
    .join("\n")}
  `;
}
export function truncate(text: string, maxLength: number): string {
  if (!text) return "";

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength) + "...";
}
