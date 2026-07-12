import { PdfCtmState, type PdfBounds, transformPdfBounds } from "./pdfGraphicsState";
import type { PdfOperatorPage } from "./pdfOperatorSource";

export interface PdfRuling {
  orientation: "horizontal" | "vertical";
  position: number;
  start: number;
  end: number;
  source: "stroke" | "thin_fill";
}

export interface PdfPageGeometry {
  page: number;
  view: PdfBounds;
  rulings: PdfRuling[];
}

export interface PdfRulingResult {
  geometry: PdfPageGeometry;
  warnings: string[];
}

interface Point {
  x: number;
  y: number;
}

interface DecodedPath {
  points: Point[];
  segments: Array<{ from: Point; to: Point }>;
  closed: boolean;
}

const AXIS_TOLERANCE = 0.25;
const MAX_THIN_FILL_WIDTH = 2.5;

export function extractPdfRulings(page: PdfOperatorPage): PdfRulingResult {
  const ctm = new PdfCtmState();
  const rulings: PdfRuling[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < page.fnArray.length; index += 1) {
    const fn = page.fnArray[index];
    const args = page.argsArray[index];
    if (fn === page.runtime.ops.save) {
      ctm.save();
      continue;
    }
    if (fn === page.runtime.ops.restore) {
      ctm.restore();
      continue;
    }
    if (fn === page.runtime.ops.transform) {
      ctm.transform(args);
      continue;
    }
    if (fn !== page.runtime.ops.constructPath) continue;

    const decoded = decodeConstructPath(args);
    if (!decoded) {
      pushUnique(warnings, "pdf_ruling_construct_path_unsupported");
      continue;
    }

    const transformed = decoded.paths.map((path) => transformPath(path, ctm));
    if (isStrokePaint(decoded.paintOp, page.runtime.ops)) {
      for (const path of transformed) {
        for (const segment of path.segments) {
          const ruling = rulingFromSegment(segment.from, segment.to, "stroke");
          if (ruling) rulings.push(ruling);
        }
      }
    } else if (isFillPaint(decoded.paintOp, page.runtime.ops)) {
      for (const path of transformed) {
        const ruling = rulingFromThinFill(path);
        if (ruling) rulings.push(ruling);
      }
    }
  }

  return {
    geometry: { page: page.pageNumber, view: page.view, rulings: uniqueRulings(rulings) },
    warnings
  };
}

function decodeConstructPath(args: unknown): { paintOp: number; paths: DecodedPath[] } | null {
  if (!Array.isArray(args) || args.length < 2) return null;
  const paintOp = Number(args[0]);
  const rawPaths = Array.isArray(args[1]) ? args[1] : null;
  if (!Number.isFinite(paintOp) || !rawPaths) return null;

  const paths: DecodedPath[] = [];
  for (const rawPath of rawPaths) {
    const values = numberArray(rawPath);
    if (!values) return null;
    const path = decodePath(values);
    if (!path) return null;
    paths.push(path);
  }
  return { paintOp, paths };
}

function decodePath(values: readonly number[]): DecodedPath | null {
  const points: Point[] = [];
  const segments: DecodedPath["segments"] = [];
  let current: Point | null = null;
  let first: Point | null = null;
  let closed = false;

  for (let index = 0; index < values.length; ) {
    const operation = values[index++];
    if (operation === 0 || operation === 1) {
      if (index + 1 >= values.length) return null;
      const next = { x: values[index++], y: values[index++] };
      if (operation === 0) {
        current = next;
        first = next;
      } else {
        if (!current) return null;
        segments.push({ from: current, to: next });
        current = next;
      }
      points.push(next);
      continue;
    }
    if (operation === 2) {
      if (!current || index + 5 >= values.length) return null;
      index += 4;
      current = { x: values[index++], y: values[index++] };
      points.push(current);
      continue;
    }
    if (operation === 3) {
      if (!current || index + 3 >= values.length) return null;
      index += 2;
      current = { x: values[index++], y: values[index++] };
      points.push(current);
      continue;
    }
    if (operation === 4) {
      if (!current || !first) return null;
      segments.push({ from: current, to: first });
      current = first;
      closed = true;
      continue;
    }
    return null;
  }

  return { points, segments, closed };
}

function transformPath(path: DecodedPath, ctm: PdfCtmState): DecodedPath {
  const matrix = ctm.current();
  const transform = (point: Point): Point => {
    const bounds = transformPdfBounds({ left: point.x, bottom: point.y, right: point.x, top: point.y }, matrix);
    return { x: bounds.left, y: bounds.bottom };
  };
  return {
    points: path.points.map(transform),
    segments: path.segments.map((segment) => ({ from: transform(segment.from), to: transform(segment.to) })),
    closed: path.closed
  };
}

function rulingFromSegment(from: Point, to: Point, source: PdfRuling["source"]): PdfRuling | null {
  if (Math.abs(from.x - to.x) <= AXIS_TOLERANCE && Math.abs(from.y - to.y) > AXIS_TOLERANCE) {
    return {
      orientation: "vertical",
      position: (from.x + to.x) / 2,
      start: Math.min(from.y, to.y),
      end: Math.max(from.y, to.y),
      source
    };
  }
  if (Math.abs(from.y - to.y) <= AXIS_TOLERANCE && Math.abs(from.x - to.x) > AXIS_TOLERANCE) {
    return {
      orientation: "horizontal",
      position: (from.y + to.y) / 2,
      start: Math.min(from.x, to.x),
      end: Math.max(from.x, to.x),
      source
    };
  }
  return null;
}

function rulingFromThinFill(path: DecodedPath): PdfRuling | null {
  if (!path.closed || path.points.length < 3) return null;
  const bounds = boundsForPoints(path.points);
  const width = bounds.right - bounds.left;
  const height = bounds.top - bounds.bottom;
  if (width <= MAX_THIN_FILL_WIDTH && height > MAX_THIN_FILL_WIDTH) {
    return {
      orientation: "vertical",
      position: (bounds.left + bounds.right) / 2,
      start: bounds.bottom,
      end: bounds.top,
      source: "thin_fill"
    };
  }
  if (height <= MAX_THIN_FILL_WIDTH && width > MAX_THIN_FILL_WIDTH) {
    return {
      orientation: "horizontal",
      position: (bounds.bottom + bounds.top) / 2,
      start: bounds.left,
      end: bounds.right,
      source: "thin_fill"
    };
  }
  return null;
}

function isStrokePaint(paintOp: number, ops: Readonly<Record<string, number>>): boolean {
  return paintOp === ops.stroke || paintOp === ops.closeStroke;
}

function isFillPaint(paintOp: number, ops: Readonly<Record<string, number>>): boolean {
  return [ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke].some(
    (candidate) => Number.isFinite(candidate) && paintOp === candidate
  );
}

function boundsForPoints(points: readonly Point[]): PdfBounds {
  return {
    left: Math.min(...points.map((point) => point.x)),
    bottom: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.max(...points.map((point) => point.y))
  };
}

function uniqueRulings(rulings: readonly PdfRuling[]): PdfRuling[] {
  const seen = new Set<string>();
  return rulings.filter((ruling) => {
    const key = [
      ruling.orientation,
      ruling.position.toFixed(2),
      ruling.start.toFixed(2),
      ruling.end.toFixed(2),
      ruling.source
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numberArray(value: unknown): number[] | null {
  const values = Array.isArray(value)
    ? value
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<unknown>)
      : null;
  if (!values) return null;
  const numbers = values.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

function pushUnique(target: string[], warning: string): void {
  if (!target.includes(warning)) target.push(warning);
}
