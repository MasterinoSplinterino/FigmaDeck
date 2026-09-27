/**
 * Alpha-aware palette search (pngquant / libimagequant style) on a weighted histogram:
 *
 * 1. Modified median cut in the premultiplied working space (see space.ts): the box with the
 *    largest weighted squared error is split along its principal axis at the point that minimises
 *    the summed error of the two halves (Wu's criterion on a sorted projection).
 * 2. A few k-means (Voronoi) iterations on the histogram, stopping when the error improves by less
 *    than `kmeansMinImprovement`. Empty cells are re-seeded with the worst-represented colour.
 * 3. Entries whose cell is dominated by one exact colour are snapped to it (flat UI colours come
 *    out exact, so dithering adds no noise to them).
 * (A split/merge "swap" refinement after k-means was tried and dropped: no gain on the gated metrics.)
 *
 * Fully transparent pixels are not in the histogram; they get one reserved transparent entry.
 */
import type { Histogram } from './histogram';
import { NearestSearch } from './nearest';
import { DIM, packRgba, premulToStraight8, spaceToPremul, type ColorSpace } from './space';

export interface QuantizeOptions {
  /** Max palette size including the transparent entry (2..256). */
  colors: number;
  kmeansIterations: number;
  /** Stop k-means when the relative error improvement of an iteration is below this. */
  kmeansMinImprovement: number;
  /** Snap an entry to its most frequent exact colour when that colour is at least this share of the cell… */
  snapMinShare: number;
  /** …and at most this far (working-space units ≈ 8-bit levels) from the centroid. */
  snapMaxDistance: number;
}

export interface Palette {
  /** Straight RGBA, 4 bytes per entry. */
  rgba: Uint8Array;
  size: number;
  /** Index of the fully transparent entry, -1 when there is none. */
  transparentIndex: number;
  /** Weighted mean squared error of the histogram against the palette (working space, per pixel). */
  histogramMse: number;
}

// ─── Median cut ──────────────────────────────────────────────────────────────

interface Box {
  start: number;
  end: number;
  weight: number;
  sse: number;
}

const TWO32 = 4294967296;
const KEY_LEVELS = 2097151; // 2^21 − 1: key × 2^32 + index stays below 2^53

function boxStats(h: Histogram, order: Uint32Array, start: number, end: number): Box {
  let w = 0;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let q = 0;
  const c = h.coords;
  for (let k = start; k < end; k++) {
    const i = order[k];
    const wi = h.weights[i];
    const o = i * DIM;
    const x0 = c[o];
    const x1 = c[o + 1];
    const x2 = c[o + 2];
    const x3 = c[o + 3];
    w += wi;
    s0 += wi * x0;
    s1 += wi * x1;
    s2 += wi * x2;
    s3 += wi * x3;
    q += wi * (x0 * x0 + x1 * x1 + x2 * x2 + x3 * x3);
  }
  const sse = w > 0 ? q - (s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3) / w : 0;
  return { start, end, weight: w, sse: sse > 1e-9 ? sse : 0 };
}

/** Principal axis (unit vector) of the box's weighted covariance, by power iteration. */
function principalAxis(h: Histogram, order: Uint32Array, box: Box): Float64Array {
  const c = h.coords;
  const mean = new Float64Array(DIM);
  for (let k = box.start; k < box.end; k++) {
    const i = order[k];
    const wi = h.weights[i];
    for (let d = 0; d < DIM; d++) mean[d] += wi * c[i * DIM + d];
  }
  for (let d = 0; d < DIM; d++) mean[d] /= box.weight;
  const cov = new Float64Array(DIM * DIM);
  const v = new Float64Array(DIM);
  for (let k = box.start; k < box.end; k++) {
    const i = order[k];
    const wi = h.weights[i];
    for (let d = 0; d < DIM; d++) v[d] = c[i * DIM + d] - mean[d];
    for (let a = 0; a < DIM; a++) {
      const wa = wi * v[a];
      for (let b = a; b < DIM; b++) cov[a * DIM + b] += wa * v[b];
    }
  }
  for (let a = 0; a < DIM; a++) for (let b = 0; b < a; b++) cov[a * DIM + b] = cov[b * DIM + a];
  // Start from the axis of largest variance.
  let axis = 0;
  for (let d = 1; d < DIM; d++) if (cov[d * DIM + d] > cov[axis * DIM + axis]) axis = d;
  let vec = new Float64Array(DIM);
  vec[axis] = 1;
  const next = new Float64Array(DIM);
  for (let it = 0; it < 24; it++) {
    let norm = 0;
    for (let a = 0; a < DIM; a++) {
      let s = 0;
      for (let b = 0; b < DIM; b++) s += cov[a * DIM + b] * vec[b];
      next[a] = s;
      norm += s * s;
    }
    norm = Math.sqrt(norm);
    if (!(norm > 0)) break;
    let change = 0;
    for (let a = 0; a < DIM; a++) {
      const nv = next[a] / norm;
      change += Math.abs(nv - vec[a]);
      vec[a] = nv;
    }
    if (change < 1e-9) break;
  }
  if (!vec.some((x) => x !== 0)) {
    vec = new Float64Array(DIM);
    vec[axis] = 1;
  }
  return vec;
}

/** Sorts the box's entries along its principal axis and splits at the SSE-optimal point. */
function splitBox(h: Histogram, order: Uint32Array, box: Box): [Box, Box] | null {
  const n = box.end - box.start;
  if (n < 2) return null;
  const axis = principalAxis(h, order, box);
  const c = h.coords;
  const proj = new Float64Array(n);
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < n; k++) {
    const o = order[box.start + k] * DIM;
    const p = c[o] * axis[0] + c[o + 1] * axis[1] + c[o + 2] * axis[2] + c[o + 3] * axis[3];
    proj[k] = p;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  if (!(max > min)) return null;
  const scale = KEY_LEVELS / (max - min);
  const packed = new Float64Array(n);
  for (let k = 0; k < n; k++) packed[k] = Math.floor((proj[k] - min) * scale) * TWO32 + k;
  packed.sort();
  const src = order.slice(box.start, box.end);
  for (let k = 0; k < n; k++) order[box.start + k] = src[packed[k] % TWO32];

  // Total sums, then scan prefixes: maximise |S_l|²/W_l + |S_r|²/W_r.
  let tw = 0;
  const ts = [0, 0, 0, 0];
  for (let k = box.start; k < box.end; k++) {
    const i = order[k];
    const wi = h.weights[i];
    tw += wi;
    for (let d = 0; d < DIM; d++) ts[d] += wi * c[i * DIM + d];
  }
  let lw = 0;
  const ls = [0, 0, 0, 0];
  let bestK = -1;
  let bestScore = -Infinity;
  for (let k = box.start; k < box.end - 1; k++) {
    const i = order[k];
    const wi = h.weights[i];
    lw += wi;
    for (let d = 0; d < DIM; d++) ls[d] += wi * c[i * DIM + d];
    const rw = tw - lw;
    if (lw <= 0 || rw <= 0) continue;
    // Equal projections cannot be separated by the sort: only split between distinct keys.
    if (packed[k - box.start] - (packed[k - box.start] % TWO32) === packed[k + 1 - box.start] - (packed[k + 1 - box.start] % TWO32)) continue;
    let l2 = 0;
    let r2 = 0;
    for (let d = 0; d < DIM; d++) {
      l2 += ls[d] * ls[d];
      const rs = ts[d] - ls[d];
      r2 += rs * rs;
    }
    const score = l2 / lw + r2 / rw;
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  if (bestK < 0) return null;
  return [boxStats(h, order, box.start, bestK + 1), boxStats(h, order, bestK + 1, box.end)];
}

/** Median cut into at most `k` boxes. Returns the centroids and each entry's box. */
function medianCut(h: Histogram, k: number): { centroids: Float64Array; count: number; assign: Int32Array } {
  const order = new Uint32Array(h.size);
  for (let i = 0; i < h.size; i++) order[i] = i;
  const boxes: Box[] = [boxStats(h, order, 0, h.size)];
  const unsplittable = new Set<Box>();
  while (boxes.length < k) {
    let best: Box | null = null;
    for (const b of boxes) if (b.sse > 0 && !unsplittable.has(b) && (!best || b.sse > best.sse)) best = b;
    if (!best) break;
    const parts = splitBox(h, order, best);
    if (!parts) {
      unsplittable.add(best);
      continue;
    }
    boxes.splice(boxes.indexOf(best), 1, parts[0], parts[1]);
  }
  const centroids = new Float64Array(boxes.length * DIM);
  const assign = new Int32Array(h.size);
  boxes.forEach((b, j) => {
    for (let kk = b.start; kk < b.end; kk++) {
      const i = order[kk];
      const wi = h.weights[i];
      assign[i] = j;
      for (let d = 0; d < DIM; d++) centroids[j * DIM + d] += wi * h.coords[i * DIM + d];
    }
    for (let d = 0; d < DIM; d++) centroids[j * DIM + d] /= b.weight;
  });
  return { centroids, count: boxes.length, assign };
}

// ─── k-means ─────────────────────────────────────────────────────────────────

interface KmeansResult {
  /** Total weighted squared error of the final assignment. */
  err: number;
  mse: number;
  /** Per entry: the histogram entry with the largest weight in its cell (-1 for an empty cell). */
  dominant: Int32Array;
  cellWeight: Float64Array;
}

/**
 * Refines `centroids` in place. Entries [movable, count) are fixed (the transparent entry) and
 * never move. `assign` holds each histogram entry's current cell and is updated.
 */
function kmeans(h: Histogram, centroids: Float64Array, count: number, movable: number, assign: Int32Array, iterations: number, minImprovement: number): KmeansResult {
  const sums = new Float64Array(count * DIM);
  const cellWeight = new Float64Array(count);
  const dominant = new Int32Array(count);
  let prevErr = Infinity;
  let err = 0;
  const c = h.coords;
  for (let it = 0; it <= iterations; it++) {
    const search = new NearestSearch(centroids, count);
    sums.fill(0);
    cellWeight.fill(0);
    dominant.fill(-1);
    err = 0;
    let worst = -1;
    let worstErr = -1;
    for (let i = 0; i < h.size; i++) {
      const o = i * DIM;
      const j = search.nearest(c[o], c[o + 1], c[o + 2], c[o + 3], assign[i]);
      assign[i] = j;
      const wi = h.weights[i];
      const e = wi * search.lastDist2;
      err += e;
      if (e > worstErr) {
        worstErr = e;
        worst = i;
      }
      cellWeight[j] += wi;
      const s = j * DIM;
      sums[s] += wi * c[o];
      sums[s + 1] += wi * c[o + 1];
      sums[s + 2] += wi * c[o + 2];
      sums[s + 3] += wi * c[o + 3];
      if (dominant[j] < 0 || wi > h.weights[dominant[j]]) dominant[j] = i;
    }
    // The last pass only measures (and fills `dominant` for the final centroids).
    const improved = prevErr === Infinity ? 1 : (prevErr - err) / Math.max(err, 1e-12);
    if (it === iterations || improved < minImprovement) break;
    prevErr = err;
    for (let j = 0; j < movable; j++) {
      const s = j * DIM;
      if (cellWeight[j] > 0) {
        for (let d = 0; d < DIM; d++) centroids[s + d] = sums[s + d] / cellWeight[j];
      } else if (worst >= 0) {
        for (let d = 0; d < DIM; d++) centroids[s + d] = c[worst * DIM + d];
        worst = -1;
      }
    }
  }
  return { err, mse: h.totalWeight > 0 ? err / h.totalWeight : 0, dominant, cellWeight };
}

// ─── Public ──────────────────────────────────────────────────────────────────

/** Palette of at most `options.colors` entries for the histogram. */
export function quantize(h: Histogram, space: ColorSpace, options: QuantizeOptions): Palette {
  const maxColors = Math.max(2, Math.min(256, options.colors | 0));
  const reserve = h.hasTransparent ? 1 : 0;
  const k = Math.max(1, maxColors - reserve);
  const entries: number[] = []; // packed straight RGBA
  let mse = 0;

  if (h.size === 0) {
    // Nothing visible.
  } else if (h.size <= k && h.colors) {
    for (let i = 0; i < h.size; i++) entries.push(h.colors[i]);
  } else {
    const cut = medianCut(h, k);
    const count = cut.count + reserve;
    const centroids = new Float64Array(count * DIM);
    centroids.set(cut.centroids);
    // Reserved transparent entry: all-zero coordinates (fixed).
    const km = kmeans(h, centroids, count, cut.count, cut.assign, options.kmeansIterations, options.kmeansMinImprovement);
    mse = km.mse;
    const premul = new Float64Array(4);
    const snap2 = options.snapMaxDistance * options.snapMaxDistance;
    for (let j = 0; j < cut.count; j++) {
      const dom = km.dominant[j];
      if (dom >= 0 && h.colors && h.weights[dom] >= options.snapMinShare * km.cellWeight[j]) {
        let d2 = 0;
        for (let d = 0; d < DIM; d++) {
          const e = centroids[j * DIM + d] - h.coords[dom * DIM + d];
          d2 += e * e;
        }
        if (d2 <= snap2) {
          entries.push(h.colors[dom]);
          continue;
        }
      }
      if (km.cellWeight[j] <= 0) continue; // never used
      spaceToPremul(space, centroids, j * DIM, premul);
      const [r, g, b, a] = premulToStraight8(premul);
      entries.push(packRgba(r, g, b, a));
    }
  }

  // Dedupe; fold alpha-0 entries into the transparent one.
  const seen = new Set<number>();
  const unique: number[] = [];
  let hasZero = reserve === 1;
  for (const e of entries) {
    if (e >>> 24 === 0) {
      hasZero = true;
      continue;
    }
    if (!seen.has(e)) {
      seen.add(e);
      unique.push(e);
    }
  }
  if (unique.length === 0 && !hasZero) hasZero = true; // degenerate: keep one entry
  const size = unique.length + (hasZero ? 1 : 0);
  const rgba = new Uint8Array(size * 4);
  unique.forEach((e, i) => {
    rgba[i * 4] = e & 255;
    rgba[i * 4 + 1] = (e >>> 8) & 255;
    rgba[i * 4 + 2] = (e >>> 16) & 255;
    rgba[i * 4 + 3] = e >>> 24;
  });
  // The transparent entry (if any) is last here; the PNG writer reorders for tRNS anyway.
  return { rgba, size, transparentIndex: hasZero ? size - 1 : -1, histogramMse: mse };
}

/** Working-space coordinates of a straight-RGBA palette (for remapping and dithering). */
export function paletteCoords(space: ColorSpace, palette: Palette): Float64Array {
  const out = new Float64Array(palette.size * DIM);
  for (let i = 0; i < palette.size; i++) {
    const r = palette.rgba[i * 4];
    const g = palette.rgba[i * 4 + 1];
    const b = palette.rgba[i * 4 + 2];
    const a = palette.rgba[i * 4 + 3];
    const f = a / 255;
    const hh = a / 2;
    out[i * DIM] = space.wr * (r * f - hh);
    out[i * DIM + 1] = space.wg * (g * f - hh);
    out[i * DIM + 2] = space.wb * (b * f - hh);
    out[i * DIM + 3] = space.wa * a;
  }
  return out;
}

/** Exact palette of an image with at most `limit` distinct colours (alpha-0 pixels → one entry), or null. */
export function exactPalette(rgba: Uint8Array, limit: number): { palette: Palette; indices: Uint8Array } | null {
  const map = new Map<number, number>();
  const n = rgba.length >> 2;
  const indices = new Uint8Array(n);
  const colors: number[] = [];
  let transparentIndex = -1;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = rgba[p + 3];
    const key = a === 0 ? 0 : packRgba(rgba[p], rgba[p + 1], rgba[p + 2], a);
    let j = map.get(key);
    if (j === undefined) {
      if (colors.length >= limit) return null;
      j = colors.length;
      colors.push(key);
      map.set(key, j);
      if (key === 0) transparentIndex = j;
    }
    indices[i] = j;
  }
  const size = colors.length;
  const out = new Uint8Array(size * 4);
  colors.forEach((e, i) => {
    out[i * 4] = e & 255;
    out[i * 4 + 1] = (e >>> 8) & 255;
    out[i * 4 + 2] = (e >>> 16) & 255;
    out[i * 4 + 3] = e >>> 24;
  });
  return { palette: { rgba: out, size, transparentIndex, histogramMse: 0 }, indices };
}
