/**
 * Per-pixel importance for the palette search (libimagequant's "noise map", simplified to 8×8
 * blocks): errors hide in texture and noise but show in smooth areas and soft gradients, so pixels
 * in busy blocks count less in the histogram and the palette spends its colours where banding and
 * colour shifts would be visible.
 *
 * Activity of a block = mean over its pixels of the largest absolute second difference (horizontal
 * or vertical) of premultiplied luma and alpha, in 8-bit levels (0 for flat areas and linear
 * gradients). Importance = min + (1 − min) / (1 + (activity / scale)²).
 */

export interface ImportanceOptions {
  /** Weight of the busiest blocks (0..1). */
  minWeight: number;
  /** Activity (8-bit levels) at which the weight is halfway down. */
  activityScale: number;
}

const B = 8;

/** Premultiplied luma (Rec. 601 weights) of pixel p. */
function luma(rgba: Uint8Array, p: number): number {
  return ((0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * rgba[p + 3]) / 255;
}

/**
 * Mean activity per 8×8 block (`ceil(w/8)` × `ceil(h/8)`, row-major): mean over the block of the
 * largest absolute second difference of premultiplied luma and alpha, 8-bit levels.
 */
export function blockActivity(rgba: Uint8Array, width: number, height: number): Float32Array {
  const bw = Math.ceil(width / B);
  const bh = Math.ceil(height / B);
  const sum = new Float64Array(bw * bh);
  const cnt = new Uint32Array(bw * bh);
  // Premultiplied luma and alpha of rows y−1, y, y+1 (rotated).
  let up = new Float32Array(width * 2);
  let mid = new Float32Array(width * 2);
  let dn = new Float32Array(width * 2);
  const loadRow = (y: number, dst: Float32Array): void => {
    for (let x = 0, p = y * width * 4; x < width; x++, p += 4) {
      dst[2 * x] = luma(rgba, p);
      dst[2 * x + 1] = rgba[p + 3];
    }
  };
  if (height < 3 || width < 3) return new Float32Array(bw * bh);
  loadRow(0, up);
  loadRow(1, mid);
  loadRow(2, dn);
  for (let y = 1; y < height - 1; y++) {
    const brow = ((y / B) | 0) * bw;
    for (let x = 1; x < width - 1; x++) {
      const i = 2 * x;
      const c = 2 * mid[i];
      const ca = 2 * mid[i + 1];
      const h = Math.abs(mid[i - 2] + mid[i + 2] - c);
      const v = Math.abs(up[i] + dn[i] - c);
      const ha = Math.abs(mid[i - 1] + mid[i + 3] - ca);
      const va = Math.abs(up[i + 1] + dn[i + 1] - ca);
      let m = h > v ? h : v;
      if (ha > m) m = ha;
      if (va > m) m = va;
      const b = brow + ((x / B) | 0);
      sum[b] += m;
      cnt[b]++;
    }
    const spare = up;
    up = mid;
    mid = dn;
    dn = spare;
    if (y + 2 < height) loadRow(y + 2, dn);
  }
  const out = new Float32Array(bw * bh);
  for (let b = 0; b < out.length; b++) out[b] = cnt[b] > 0 ? sum[b] / cnt[b] : 0;
  return out;
}

/** Block importance (histogram weight per 8×8 block, min..1) from `blockActivity`. */
export function blockImportance(activity: Float32Array, width: number, options: ImportanceOptions): BlockWeights {
  const map = new Float32Array(activity.length);
  const minW = Math.max(0, Math.min(1, options.minWeight));
  const s = options.activityScale;
  for (let b = 0; b < map.length; b++) {
    const r = activity[b] / s;
    map[b] = minW + (1 - minW) / (1 + r * r);
  }
  return { map, blocksWide: Math.ceil(width / B) };
}

/** Histogram weight per 8×8 block (row-major, `blocksWide` per row). */
export interface BlockWeights {
  map: Float32Array;
  blocksWide: number;
}
