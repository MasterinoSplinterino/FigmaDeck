/**
 * 2D geometry for extraction: Figma affine matrices, decomposition into PowerPoint `xfrm` terms,
 * axis-aligned rectangles.
 *
 * Conventions (all lengths in Figma px):
 * - `Matrix` is Figma's 2×3 `[[a, c, tx], [b, d, ty]]`: x' = a·x + c·y + tx, y' = b·x + d·y + ty.
 *   Columns (a, b) and (c, d) are the images of the node's local x and y axes.
 * - The canvas is y-down, so a matrix whose x axis points to (cos θ, sin θ) is a CLOCKWISE rotation
 *   by θ on screen (Figma's own `rotation` property is the counter-clockwise angle, i.e. −θ).
 * - `multiply(m, n)` applies `n` first, then `m` (standard matrix product m × n).
 *
 * Pure functions, no Figma API.
 */
import { CONFIG } from '../config';
import type { Matrix, Rect, Transform } from '../ir/types';

export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
];

/** m × n (apply `n`, then `m`). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    [
      m[0][0] * n[0][0] + m[0][1] * n[1][0],
      m[0][0] * n[0][1] + m[0][1] * n[1][1],
      m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2],
    ],
    [
      m[1][0] * n[0][0] + m[1][1] * n[1][0],
      m[1][0] * n[0][1] + m[1][1] * n[1][1],
      m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2],
    ],
  ];
}

/** Inverse of an affine matrix. Throws for a singular matrix (zero-size / degenerate transform). */
export function invert(m: Matrix): Matrix {
  const [[a, c, tx], [b, d, ty]] = m;
  const det = a * d - b * c;
  if (!isFinite(det) || Math.abs(det) < 1e-12) throw new Error('invert: singular matrix');
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [
    [ia, ic, -(ia * tx + ic * ty)],
    [ib, id, -(ib * tx + id * ty)],
  ];
}

export function applyToPoint(m: Matrix, p: Point): Point {
  return { x: m[0][0] * p.x + m[0][1] * p.y + m[0][2], y: m[1][0] * p.x + m[1][1] * p.y + m[1][2] };
}

export function translation(x: number, y: number): Matrix {
  return [
    [1, 0, x],
    [0, 1, y],
  ];
}

/** Removes float noise (1e-13 → 0, 99.99999999 → 100) so IR numbers stay readable and stable. */
export function clean(v: number): number {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-6) return r === 0 ? 0 : r;
  return Math.round(v * 1e6) / 1e6;
}

/** Degrees normalized to [0, 360), snapped to multiples of 90° within `CONFIG.extract.rotationSnapDeg`. */
export function normalizeDegrees(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  const q = Math.round(d / 90) * 90;
  if (Math.abs(d - q) < CONFIG.extract.rotationSnapDeg) d = q;
  d = clean(d);
  return d >= 360 ? 0 : d;
}

export interface Decomposition {
  /** Unrotated box around the node center, clockwise rotation, flipH when mirrored (flipV never set). */
  transform: Transform;
  /** det < 0 (mirrored). */
  flipped: boolean;
  /** Axes not orthogonal or not of unit length: not representable as xfrm (rasterize, reason `transform`). */
  skewed: boolean;
}

/**
 * Decompose the matrix that places a `w × h` node (its local box [0,w]×[0,h]) into PowerPoint `xfrm`
 * terms: unrotated box centered on the node's center, then flipH in local space, then clockwise
 * rotation about the center.
 *
 * Mirrored matrices (det < 0) are written as M = R·diag(−1, 1): flipH plus the rotation of
 * M·diag(−1, 1). Figma never stores scale in transforms (sizes live in width/height), so any axis
 * length ≠ 1 is treated like skew.
 */
export function decompose(m: Matrix, w: number, h: number): Decomposition {
  const a = m[0][0];
  const b = m[1][0];
  const c = m[0][1];
  const d = m[1][1];
  const det = a * d - b * c;
  const flipped = det < 0;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const eps = CONFIG.extract.matrixEpsilon;
  const orthogonal = sx > 0 && sy > 0 && Math.abs(a * c + b * d) / (sx * sy) <= eps;
  const unit = Math.abs(sx - 1) <= eps && Math.abs(sy - 1) <= eps;
  // x axis of M·diag(−1, 1) is −(a, b) when mirrored.
  const xa = flipped ? -a : a;
  const xb = flipped ? -b : b;
  const rotation = normalizeDegrees((Math.atan2(xb, xa) * 180) / Math.PI);
  const center = applyToPoint(m, { x: w / 2, y: h / 2 });
  return {
    transform: {
      x: clean(center.x - w / 2),
      y: clean(center.y - h / 2),
      w: clean(w),
      h: clean(h),
      rotation,
      flipH: flipped,
      flipV: false,
    },
    flipped,
    skewed: !(orthogonal && unit),
  };
}

/**
 * Placement of an axis-aligned rectangle given in ABSOLUTE canvas coordinates (e.g. the region an
 * `exportAsync` bitmap covers) in slide coordinates. `slideInverse` = inverse(frame.absoluteTransform).
 * For an unrotated frame this is a plain translation; for a rotated frame the picture gets the
 * inverse rotation so the bitmap lands where Figma shows it.
 */
export function placeAbsoluteRect(slideInverse: Matrix, r: Rect): Transform {
  return decompose(multiply(slideInverse, translation(r.x, r.y)), r.w, r.h).transform;
}

// ─── Rectangles ─────────────────────────────────────────────────────────────

export function rectArea(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/** Intersection, or `null` when empty (touching edges count as empty). */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** `outer` contains `inner` (with a tolerance in px). */
export function containsRect(outer: Rect, inner: Rect, eps: number = CONFIG.extract.geometryEpsilonPx): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  );
}

/** Rectangles are equal within `eps` px. */
export function rectsEqual(a: Rect, b: Rect, eps: number = CONFIG.extract.geometryEpsilonPx): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.w - b.w) <= eps &&
    Math.abs(a.h - b.h) <= eps
  );
}

/** Axis-aligned bounds of the box [0,w]×[0,h] mapped by `m`. */
export function transformedBoxBounds(m: Matrix, w: number, h: number): Rect {
  const pts = [
    applyToPoint(m, { x: 0, y: 0 }),
    applyToPoint(m, { x: w, y: 0 }),
    applyToPoint(m, { x: w, y: h }),
    applyToPoint(m, { x: 0, y: h }),
  ];
  return pointsBounds(pts);
}

/** Axis-aligned bounds of a rectangle mapped by `m` (e.g. absolute render bounds → slide coordinates). */
export function transformRectBounds(m: Matrix, r: Rect): Rect {
  return transformedBoxBounds(multiply(m, translation(r.x, r.y)), r.w, r.h);
}

/** Axis-aligned bounds of an IR transform (rotated box). Flips do not change the bounds. */
export function transformBounds(t: Transform): Rect {
  if (t.rotation === 0 || t.rotation === 180) return { x: t.x, y: t.y, w: t.w, h: t.h };
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  if (t.rotation === 90 || t.rotation === 270) return { x: cx - t.h / 2, y: cy - t.w / 2, w: t.h, h: t.w };
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const bw = t.w * cos + t.h * sin;
  const bh = t.w * sin + t.h * cos;
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}

function pointsBounds(pts: readonly Point[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Rotation is a multiple of 90° (an axis-aligned box stays axis-aligned). */
export function isQuarterTurn(rotation: number): boolean {
  return rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270;
}

/** Round a rect's numbers for stable IR output. */
export function cleanRect(r: Rect): Rect {
  return { x: clean(r.x), y: clean(r.y), w: clean(r.w), h: clean(r.h) };
}
