import {
  matrixFromUnknown,
  multiplyPdfMatrices,
  PdfCtmState,
  type PdfBounds,
  type PdfMatrix,
  transformPdfBounds
} from "./pdfGraphicsState";
import type { PdfOperatorPage } from "./pdfOperatorSource";

export interface PdfOperatorGlyph {
  text: string;
  bounds: PdfBounds;
}

export interface PdfOperatorTextRun {
  page: number;
  fontName: string;
  baselineY: number;
  text: string;
  glyphs: PdfOperatorGlyph[];
  bounds: PdfBounds;
}

interface ParsedGlyph {
  text: string;
  width: number;
  isSpace: boolean;
}

export function collectPdfOperatorTextRuns(page: PdfOperatorPage): PdfOperatorTextRun[] {
  const ops = page.runtime.ops;
  const ctm = new PdfCtmState();
  const runs: PdfOperatorTextRun[] = [];
  let inText = false;
  let matrixReady = false;
  let textMatrix: PdfMatrix | null = null;
  let fontName = "";
  let fontSize = 0;
  let horizontalScale = 1;
  let charSpacing = 0;
  let wordSpacing = 0;

  for (let index = 0; index < page.fnArray.length; index += 1) {
    const fn = page.fnArray[index];
    const args = page.argsArray[index];

    if (fn === ops.save) {
      ctm.save();
      continue;
    }
    if (fn === ops.restore) {
      ctm.restore();
      continue;
    }
    if (fn === ops.transform) {
      ctm.transform(args);
      continue;
    }
    if (fn === ops.beginText) {
      inText = true;
      matrixReady = false;
      textMatrix = null;
      continue;
    }
    if (fn === ops.endText) {
      inText = false;
      matrixReady = false;
      textMatrix = null;
      continue;
    }
    if (fn === ops.setFont && Array.isArray(args)) {
      fontName = String(args[0] ?? "");
      fontSize = Number(args[1] ?? 0);
      continue;
    }
    if (fn === ops.setHScale) {
      const value = scalar(args);
      if (value !== null) horizontalScale = Math.abs(value) > 10 ? value / 100 : value;
      continue;
    }
    if (fn === ops.setCharSpacing) {
      const value = scalar(args);
      if (value !== null) charSpacing = value;
      continue;
    }
    if (fn === ops.setWordSpacing) {
      const value = scalar(args);
      if (value !== null) wordSpacing = value;
      continue;
    }
    if (fn === ops.setTextMatrix) {
      textMatrix = matrixFromUnknown(args);
      matrixReady = textMatrix !== null;
      continue;
    }
    if (isUnsupportedTextPositioning(fn, ops)) {
      matrixReady = false;
      textMatrix = null;
      continue;
    }
    if (fn !== ops.showText) continue;

    if (inText && matrixReady && textMatrix && fontName && Number.isFinite(fontSize) && fontSize !== 0) {
      const run = parseShowText(page.pageNumber, args, {
        fontName,
        fontSize,
        horizontalScale,
        charSpacing,
        wordSpacing,
        matrix: multiplyPdfMatrices(ctm.current(), textMatrix)
      });
      if (run) runs.push(run);
    }

    // A following showText depends on the text-position advance performed by
    // PDF.js. Require a fresh explicit matrix instead of partially emulating it.
    matrixReady = false;
    textMatrix = null;
  }

  return runs;
}

function parseShowText(
  page: number,
  args: unknown,
  state: {
    fontName: string;
    fontSize: number;
    horizontalScale: number;
    charSpacing: number;
    wordSpacing: number;
    matrix: PdfMatrix;
  }
): PdfOperatorTextRun | null {
  const entries = Array.isArray(args) ? args[0] : null;
  if (!Array.isArray(entries)) return null;

  let cursor = 0;
  const glyphs: PdfOperatorGlyph[] = [];
  for (const entry of entries) {
    if (typeof entry === "number") {
      cursor += (-entry / 1000) * state.fontSize * state.horizontalScale;
      continue;
    }

    const glyph = parsedGlyph(entry);
    if (!glyph) return null;
    const advance =
      (glyph.width / 1000) * state.fontSize * state.horizontalScale +
      state.charSpacing * state.horizontalScale +
      (glyph.isSpace ? state.wordSpacing * state.horizontalScale : 0);
    const start = cursor;
    cursor += advance;
    if (!glyph.text) continue;

    glyphs.push({
      text: glyph.text,
      bounds: transformPdfBounds(
        {
          left: Math.min(start, cursor),
          bottom: Math.min(0, state.fontSize),
          right: Math.max(start, cursor),
          top: Math.max(0, state.fontSize)
        },
        state.matrix
      )
    });
  }

  if (glyphs.length === 0) return null;
  const baseline = transformPdfBounds({ left: 0, bottom: 0, right: 0, top: 0 }, state.matrix);
  return {
    page,
    fontName: state.fontName,
    baselineY: baseline.bottom,
    text: glyphs.map((glyph) => glyph.text).join(""),
    glyphs,
    bounds: unionBounds(glyphs.map((glyph) => glyph.bounds))
  };
}

function parsedGlyph(value: unknown): ParsedGlyph | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  if (!Number.isFinite(width)) return null;
  const text = typeof record.unicode === "string" ? record.unicode : "";
  return { text, width, isSpace: record.isSpace === true || text === " " };
}

function scalar(value: unknown): number | null {
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(number) ? number : null;
}

function isUnsupportedTextPositioning(fn: number, ops: Readonly<Record<string, number>>): boolean {
  return [
    ops.moveText,
    ops.setLeadingMoveText,
    ops.nextLine,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText
  ].some((candidate) => Number.isFinite(candidate) && fn === candidate);
}

function unionBounds(bounds: readonly PdfBounds[]): PdfBounds {
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    bottom: Math.min(...bounds.map((item) => item.bottom)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.max(...bounds.map((item) => item.top))
  };
}
