export interface PdfBounds {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export type PdfMatrix = [number, number, number, number, number, number];

const IDENTITY_MATRIX: PdfMatrix = [1, 0, 0, 1, 0, 0];

export class PdfCtmState {
  private readonly stack: PdfMatrix[] = [];
  private matrix: PdfMatrix = [...IDENTITY_MATRIX];

  current(): PdfMatrix {
    return [...this.matrix];
  }

  save(): void {
    this.stack.push([...this.matrix]);
  }

  restore(): boolean {
    const restored = this.stack.pop();
    if (!restored) return false;
    this.matrix = restored;
    return true;
  }

  transform(value: unknown): boolean {
    const next = matrixFromUnknown(value);
    if (!next) return false;
    this.matrix = multiplyPdfMatrices(this.matrix, next);
    return true;
  }
}

export function matrixFromUnknown(value: unknown): PdfMatrix | null {
  const candidate = Array.isArray(value) && value.length === 1 && typeof value[0] === "object" ? value[0] : value;
  const numbers = numberArray(candidate);
  if (!numbers || numbers.length < 6) return null;
  return [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]];
}

export function multiplyPdfMatrices(left: PdfMatrix, right: PdfMatrix): PdfMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

export function transformPdfBounds(bounds: PdfBounds, matrix: PdfMatrix): PdfBounds {
  const corners = [
    transformPoint(bounds.left, bounds.bottom, matrix),
    transformPoint(bounds.left, bounds.top, matrix),
    transformPoint(bounds.right, bounds.bottom, matrix),
    transformPoint(bounds.right, bounds.top, matrix)
  ];
  return {
    left: Math.min(...corners.map(([x]) => x)),
    bottom: Math.min(...corners.map(([, y]) => y)),
    right: Math.max(...corners.map(([x]) => x)),
    top: Math.max(...corners.map(([, y]) => y))
  };
}

function transformPoint(x: number, y: number, matrix: PdfMatrix): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
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
