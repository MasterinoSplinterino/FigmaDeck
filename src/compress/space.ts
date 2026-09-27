/**
 * Working colour space of the quantizer and the ditherer.
 *
 * Pixels are handled premultiplied (sRGB-encoded channel × alpha, 0..255): that is what a viewer
 * composites, so fully transparent colours are all equal and faint pixels weigh little.
 *
 * The squared error of a premultiplied difference (Δc, Δa) is the average of the visible error
 * composited over black (Δc) and over white (Δc − Δa):
 *   ((Δc)² + (Δc − Δa)²) / 2 = (Δc − Δa/2)² + Δa²/4,
 * summed over r, g, b with optional channel weights w_c. That quadratic form is Euclidean in
 *   x_c = w_c · (p_c − a/2)   (c = r, g, b),     x_a = a · sqrt(w_r² + w_g² + w_b²) / 2
 * so centroids (k-means), box statistics (median cut) and error diffusion, which are all linear,
 * are computed on x directly and nearest-colour search is a plain Euclidean search.
 */

/** Coordinates per colour. */
export const DIM = 4;

export interface ColorSpace {
  readonly wr: number;
  readonly wg: number;
  readonly wb: number;
  /** Alpha coefficient, derived: sqrt(wr² + wg² + wb²) / 2. */
  readonly wa: number;
}

export function makeColorSpace(weights: readonly [number, number, number] = [1, 1, 1]): ColorSpace {
  const [wr, wg, wb] = weights;
  return { wr, wg, wb, wa: Math.sqrt(wr * wr + wg * wg + wb * wb) / 2 };
}

/** Straight 8-bit RGBA → working coordinates, written to out[o..o+3]. */
export function straightToSpace(s: ColorSpace, r: number, g: number, b: number, a: number, out: Float64Array, o: number): void {
  const f = a / 255;
  const h = a / 2;
  out[o] = s.wr * (r * f - h);
  out[o + 1] = s.wg * (g * f - h);
  out[o + 2] = s.wb * (b * f - h);
  out[o + 3] = s.wa * a;
}

/** Working coordinates → premultiplied RGBA (floats, 0..255, not clamped). */
export function spaceToPremul(s: ColorSpace, x: ArrayLike<number>, o: number, out: Float64Array): void {
  const a = x[o + 3] / s.wa;
  const h = a / 2;
  out[0] = x[o] / s.wr + h;
  out[1] = x[o + 1] / s.wg + h;
  out[2] = x[o + 2] / s.wb + h;
  out[3] = a;
}

/** Nearest straight 8-bit RGBA of a premultiplied colour (alpha 0 → transparent black). */
export function premulToStraight8(p: ArrayLike<number>): [number, number, number, number] {
  const a = Math.round(Math.min(255, Math.max(0, p[3])));
  if (a === 0) return [0, 0, 0, 0];
  const k = 255 / a;
  const c = (v: number): number => Math.round(Math.min(255, Math.max(0, v * k)));
  return [c(p[0]), c(p[1]), c(p[2]), a];
}

/** Squared distance between two coordinate vectors. */
export function dist2(x: ArrayLike<number>, i: number, y: ArrayLike<number>, j: number): number {
  const d0 = x[i] - y[j];
  const d1 = x[i + 1] - y[j + 1];
  const d2 = x[i + 2] - y[j + 2];
  const d3 = x[i + 3] - y[j + 3];
  return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
}

/** Packs straight RGBA into one unsigned 32-bit key (r in the low byte). */
export function packRgba(r: number, g: number, b: number, a: number): number {
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}
