import type { PdfEdgeOverflowMenuEvidence } from "./pdfEdgeOverflow";

export interface SharedRowBand {
  id: string;
  page: number;
  minY: number;
  maxY: number;
}

export interface SharedRowOverflowResolution {
  evidenceByRowId: Map<string, PdfEdgeOverflowMenuEvidence[]>;
  warnings: string[];
}

/** Assigns strong extraction evidence only when exactly one shared row owns it. */
export function resolveSharedRowOverflow(
  evidence: readonly PdfEdgeOverflowMenuEvidence[],
  bands: readonly SharedRowBand[]
): SharedRowOverflowResolution {
  const evidenceByRowId = new Map<string, PdfEdgeOverflowMenuEvidence[]>();
  const warnings = new Set<string>();

  for (const item of evidence) {
    const matching = bands.filter(
      (band) => band.page === item.page && item.baselineY >= band.minY && item.baselineY <= band.maxY
    );
    if (matching.length === 0) {
      warnings.add("pdf_text_edge_overflow_unassigned");
      continue;
    }
    if (matching.length > 1) {
      warnings.add("pdf_text_edge_overflow_ambiguous");
      continue;
    }

    const rowEvidence = evidenceByRowId.get(matching[0].id) ?? [];
    rowEvidence.push(item);
    evidenceByRowId.set(matching[0].id, rowEvidence);
  }

  return { evidenceByRowId, warnings: Array.from(warnings) };
}
