/**
 * Weighted colour histogram of the visible (alpha > 0) pixels, in the working colour space.
 *
 * Exact colours are counted in an open-addressing hash table. When there are more distinct colours
 * than `maxEntries`, the table is re-binned in place by dropping one more low bit per channel. Each
 * bin keeps the sums of its pixels, so its coordinates are the exact centroid of its pixels, not the
 * bin corner: binning only limits how finely the palette search can separate colours.
 */
import type { BlockWeights } from './importance';
import { DIM, type ColorSpace } from './space';

export interface Histogram {
  /** Number of entries. */
  size: number;
  /** DIM working-space coordinates per entry (weighted centroid of its pixels). */
  coords: Float64Array;
  /** Weight per entry (pixel count, or the sum of per-pixel importance). */
  weights: Float64Array;
  /** Straight RGBA of each entry (`packRgba`) when the histogram is exact (`shift === 0`), else null. */
  colors: Uint32Array | null;
  totalWeight: number;
  /** At least one (sampled) pixel is fully transparent. */
  hasTransparent: boolean;
  /** Low bits dropped per channel (0 = exact colours). */
  shift: number;
}

export interface HistogramOptions {
  /** Max distinct entries before re-binning (≥ 256). */
  maxEntries: number;
  /** Sample every `step`-th pixel in both directions (1 = all pixels). */
  step?: number;
  /** Optional weight per 8×8 block (see importance.ts); default 1. */
  importance?: BlockWeights | null;
}

const EMPTY = 0;

function hashBits(capacity: number): number {
  return 31 - Math.clz32(capacity);
}

export function buildHistogram(rgba: Uint8Array, width: number, height: number, space: ColorSpace, options: HistogramOptions): Histogram {
  const maxEntries = Math.max(256, options.maxEntries | 0);
  const step = Math.max(1, options.step ?? 1) | 0;
  const importance = options.importance ?? null;

  let capacity = 1;
  while (capacity < maxEntries * 2) capacity <<= 1;
  const bits = hashBits(capacity);
  const mask = capacity - 1;
  const slots = new Int32Array(capacity); // entry index + 1, 0 = empty
  const keys = new Uint32Array(maxEntries + 1);
  const weight = new Float64Array(maxEntries + 1);
  // Premultiplied sums × weight: r·a, g·a, b·a (scaled by 1/255 at the end), a.
  const sums = new Float64Array((maxEntries + 1) * 4);
  let size = 0;
  let shift = 0;
  let hasTransparent = false;

  const insert = (key: number): number => {
    let h = Math.imul(key, 0x9e3779b1) >>> (32 - bits);
    for (;;) {
      const s = slots[h];
      if (s === EMPTY) {
        keys[size] = key;
        slots[h] = ++size;
        return size - 1;
      }
      if (keys[s - 1] === key) return s - 1;
      h = (h + 1) & mask;
    }
  };

  /** Drops one more bit per channel and merges the entries that now share a key (sums are additive). */
  const rebin = (): void => {
    const n = size;
    const oldKeys = keys.slice(0, n);
    const oldW = weight.slice(0, n);
    const oldS = sums.slice(0, n * 4);
    shift++;
    slots.fill(EMPTY);
    size = 0;
    weight.fill(0, 0, n);
    sums.fill(0, 0, n * 4);
    for (let i = 0; i < n; i++) {
      const j = insert((oldKeys[i] >>> 1) & 0x7f7f7f7f);
      weight[j] += oldW[i];
      const si = i * 4;
      const sj = j * 4;
      sums[sj] += oldS[si];
      sums[sj + 1] += oldS[si + 1];
      sums[sj + 2] += oldS[si + 2];
      sums[sj + 3] += oldS[si + 3];
    }
  };

  const offsetStep = step > 1 ? 7 % step || 1 : 0;
  for (let y = 0, row = 0; y < height; y += step, row++) {
    // Jitter the column phase per sampled row so periodic patterns are not aliased.
    const x0 = step > 1 ? (row * offsetStep) % step : 0;
    let p = (y * width + x0) * 4;
    const brow = importance ? (y >> 3) * importance.blocksWide : 0;
    for (let x = x0; x < width; x += step, p += 4 * step) {
      const a = rgba[p + 3];
      if (a === 0) {
        hasTransparent = true;
        continue;
      }
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      const key = ((r >>> shift) | ((g >>> shift) << 8) | ((b >>> shift) << 16) | ((a >>> shift) << 24)) >>> 0;
      const j = insert(key);
      const w = importance ? importance.map[brow + (x >> 3)] : 1;
      weight[j] += w;
      const s = j * 4;
      const wa = w * a;
      sums[s] += wa * r;
      sums[s + 1] += wa * g;
      sums[s + 2] += wa * b;
      sums[s + 3] += wa;
      if (size > maxEntries) rebin();
    }
  }

  const coords = new Float64Array(size * DIM);
  const weights = new Float64Array(size);
  let totalWeight = 0;
  for (let i = 0; i < size; i++) {
    const w = weight[i];
    weights[i] = w;
    totalWeight += w;
    const s = i * 4;
    const pr = sums[s] / 255 / w;
    const pg = sums[s + 1] / 255 / w;
    const pb = sums[s + 2] / 255 / w;
    const pa = sums[s + 3] / w;
    const h = pa / 2;
    const o = i * DIM;
    coords[o] = space.wr * (pr - h);
    coords[o + 1] = space.wg * (pg - h);
    coords[o + 2] = space.wb * (pb - h);
    coords[o + 3] = space.wa * pa;
  }
  return {
    size,
    coords,
    weights,
    colors: shift === 0 ? keys.slice(0, size) : null,
    totalWeight,
    hasTransparent,
    shift,
  };
}
