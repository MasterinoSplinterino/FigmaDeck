/**
 * Remapping an RGBA image onto a palette:
 * - `remapNearest`: plain nearest colour (exact search, direct-mapped cache of recent colours);
 * - `ditherMap`: pngquant-style adaptive dither strength per pixel (0..255): low on edges and in
 *   noisy texture (where diffusion only adds noise and bytes), high inside large areas that the plain
 *   remap turns into one flat index — exactly where banding would show;
 * - `remapDither`: serpentine Floyd–Steinberg error diffusion in the premultiplied working space,
 *   with the error scaled per pixel by strength × dither map, limited near the gamut edge, skipped
 *   when negligible and damped when large (pngquant's safeguards against speckles).
 * Fully transparent pixels always map to the transparent entry and neither take nor pass error.
 */
import { NearestSearch } from './nearest';
import type { Palette } from './quantize';
import { DIM, type ColorSpace } from './space';

const CACHE_BITS = 16;

/** Nearest-colour remap. Returns the indices and the mean squared error (working space, visible pixels). */
export function remapNearest(rgba: Uint8Array, width: number, height: number, space: ColorSpace, palette: Palette, coords: Float64Array, search?: NearestSearch): { indices: Uint8Array; mse: number } {
  const n = width * height;
  const indices = new Uint8Array(n);
  const nn = search ?? new NearestSearch(coords, palette.size);
  const cacheKeys = new Uint32Array(1 << CACHE_BITS);
  const cacheVals = new Int32Array(1 << CACHE_BITS).fill(-1);
  const cacheErr = new Float64Array(1 << CACHE_BITS);
  const t = palette.transparentIndex;
  const { wr, wg, wb, wa } = space;
  let last = t >= 0 ? t : 0;
  let err = 0;
  let visible = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = rgba[p + 3];
    if (a === 0 && t >= 0) {
      indices[i] = t;
      continue;
    }
    visible++;
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const key = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
    const slot = Math.imul(key, 0x9e3779b1) >>> (32 - CACHE_BITS);
    if (cacheVals[slot] >= 0 && cacheKeys[slot] === key) {
      last = cacheVals[slot];
      indices[i] = last;
      err += cacheErr[slot];
      continue;
    }
    const f = a / 255;
    const h = a / 2;
    last = nn.nearest(wr * (r * f - h), wg * (g * f - h), wb * (b * f - h), wa * a, last);
    indices[i] = last;
    cacheKeys[slot] = key;
    cacheVals[slot] = last;
    cacheErr[slot] = nn.lastDist2;
    err += nn.lastDist2;
  }
  return { indices, mse: visible > 0 ? err / visible : 0 };
}

export interface DitherMapOptions {
  /** Edge sensitivity: dither level drops by `edgeScale` × (max second difference, 8-bit levels). */
  edgeScale: number;
}

/** Separable 3×3 min (erode) or max (dilate) of `src`, in place; `tmp` is scratch of the same size. */
function morph3(src: Uint8Array, tmp: Uint8Array, width: number, height: number, max: boolean): void {
  for (let y = 0; y < height; y++) {
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const l = src[o + (x > 0 ? x - 1 : x)];
      const c = src[o + x];
      const r = src[o + (x < width - 1 ? x + 1 : x)];
      tmp[o + x] = max ? (l > c ? (l > r ? l : r) : c > r ? c : r) : l < c ? (l < r ? l : r) : c < r ? c : r;
    }
  }
  for (let y = 0; y < height; y++) {
    const o = y * width;
    const up = y > 0 ? o - width : o;
    const dn = y < height - 1 ? o + width : o;
    for (let x = 0; x < width; x++) {
      const l = tmp[up + x];
      const c = tmp[o + x];
      const r = tmp[dn + x];
      src[o + x] = max ? (l > c ? (l > r ? l : r) : c > r ? c : r) : l < c ? (l < r ? l : r) : c < r ? c : r;
    }
  }
}

/**
 * Per-pixel dither level (0..255). `base` is the undithered remap; `scratch` is a w×h buffer that
 * is overwritten (pass the output index buffer to avoid another allocation).
 */
export function ditherMap(rgba: Uint8Array, width: number, height: number, base: Uint8Array, options: DitherMapOptions, scratch?: Uint8Array): Uint8Array {
  const n = width * height;
  const map = new Uint8Array(n);
  const tmp = scratch && scratch.length >= n ? scratch : new Uint8Array(n);
  const k = options.edgeScale;
  // Premultiplied rows y−1, y, y+1 (rotated), 4 floats per pixel.
  const rowLen = width * 4;
  let up = new Float32Array(rowLen);
  let mid = new Float32Array(rowLen);
  let dn = new Float32Array(rowLen);
  const loadRow = (y: number, dst: Float32Array): void => {
    const o = y * rowLen;
    for (let x = 0; x < rowLen; x += 4) {
      const a = rgba[o + x + 3];
      const f = a / 255;
      dst[x] = rgba[o + x] * f;
      dst[x + 1] = rgba[o + x + 1] * f;
      dst[x + 2] = rgba[o + x + 2] * f;
      dst[x + 3] = a;
    }
  };
  loadRow(0, mid);
  up.set(mid);
  if (height > 1) loadRow(1, dn);
  else dn.set(mid);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const c = x * 4;
      const l = x > 0 ? c - 4 : c;
      const r = x < width - 1 ? c + 4 : c;
      let edge = 0;
      for (let ch = 0; ch < 4; ch++) {
        const c2 = 2 * mid[c + ch];
        const hz = Math.abs(mid[l + ch] + mid[r + ch] - c2);
        const vt = Math.abs(up[c + ch] + dn[c + ch] - c2);
        if (hz > edge) edge = hz;
        if (vt > edge) edge = vt;
      }
      const e = 255 - edge * k;
      map[o + x] = e > 0 ? (e < 255 ? e : 255) : 0;
    }
    // Rotate: up ← mid ← dn ← row y + 2 (edge rows repeat).
    const spare = up;
    up = mid;
    mid = dn;
    dn = spare;
    if (y + 2 < height) loadRow(y + 2, dn);
    else dn.set(mid);
  }
  // Opening (erode, then dilate): thin flat specks inside edges/noise do not get full dithering.
  morph3(map, tmp, width, height, false);
  morph3(map, tmp, width, height, true);

  // Runs of one index in the plain remap (with the same index above / below) are where banding
  // shows: full dithering there; short runs (already varied) get less.
  const scale = 255 / (255 + 128);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    let start = 0;
    while (start < width) {
      const v = base[o + start];
      let end = start + 1;
      while (end < width && base[o + end] === v) end++;
      let count = 10 * (end - start);
      for (let x = start; x < end; x++) {
        if (y > 0 && base[o - width + x] === v) count += 15;
        if (y < height - 1 && base[o + width + x] === v) count += 15;
      }
      const f = scale * (1 - 20 / (20 + count));
      for (let x = start; x < end; x++) map[o + x] = Math.round((map[o + x] + 128) * f);
      start = end;
    }
  }
  return map;
}

export interface DitherOptions {
  /** 0..1 global strength. */
  strength: number;
  /** Per-pixel level 0..255 (`ditherMap`), or null for uniform `strength`. */
  map: Uint8Array | null;
  /** Undithered indices used as search guesses (speed only), or null. */
  guess: Uint8Array | null;
  /** Accumulated error below this (squared, working space) is not dithered: the chain stops. */
  minError2: number;
  /** Error above this (squared) is damped (×0.8 when applied, ×0.75 when passed on). */
  maxError2: number;
  /** How far (premultiplied 8-bit levels) a dithered target may leave the valid colour range. */
  overflow: number;
}

/** Floyd–Steinberg (serpentine) remap. Returns the palette indices. */
export function remapDither(rgba: Uint8Array, width: number, height: number, space: ColorSpace, palette: Palette, coords: Float64Array, options: DitherOptions, search?: NearestSearch, out?: Uint8Array): Uint8Array {
  const n = width * height;
  const indices = out && out.length >= n ? out : new Uint8Array(n);
  const nn = search ?? new NearestSearch(coords, palette.size);
  const t = palette.transparentIndex;
  const { wr, wg, wb, wa } = space;
  const stride = (width + 2) * DIM;
  let cur = new Float32Array(stride);
  let next = new Float32Array(stride);
  const strength = Math.max(0, Math.min(1, options.strength));
  const { map, guess, minError2, maxError2 } = options;
  const m = options.overflow;
  let last = t >= 0 ? t : 0;

  for (let y = 0; y < height; y++) {
    next.fill(0);
    const ltr = (y & 1) === 0;
    const dir = ltr ? 1 : -1;
    for (let k = 0, x = ltr ? 0 : width - 1; k < width; k++, x += dir) {
      const i = y * width + x;
      const p = i * 4;
      const a = rgba[p + 3];
      if (a === 0 && t >= 0) {
        indices[i] = t;
        last = t;
        continue;
      }
      const f = a / 255;
      const h = a / 2;
      const r8 = rgba[p];
      const g8 = rgba[p + 1];
      const b8 = rgba[p + 2];
      const x0 = wr * (r8 * f - h);
      const x1 = wg * (g8 * f - h);
      const x2 = wb * (b8 * f - h);
      const x3 = wa * a;
      const e = (x + 1) * DIM;
      const level = map ? (strength * map[i]) / 255 : strength;
      let s0 = cur[e] * level;
      let s1 = cur[e + 1] * level;
      let s2 = cur[e + 2] * level;
      let s3 = cur[e + 3] * level;
      let t0 = x0;
      let t1 = x1;
      let t2 = x2;
      let t3 = x3;
      const mag = s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3;
      if (mag >= minError2) {
        // Largest ratio keeping the target inside the (slightly widened) valid range.
        let ratio = 1;
        const aMax = 255 * wa;
        if (x3 + s3 > aMax) ratio = Math.min(ratio, (aMax - x3) / s3);
        else if (x3 + s3 < 0) ratio = Math.min(ratio, -x3 / s3);
        // Colour channel c: |x_c| ≤ w_c · (a/2 + m) (premultiplied value within [−m, a + m]).
        const lim0 = wr * (h + m);
        const lim1 = wg * (h + m);
        const lim2 = wb * (h + m);
        if (x0 + s0 > lim0) ratio = Math.min(ratio, (lim0 - x0) / s0);
        else if (x0 + s0 < -lim0) ratio = Math.min(ratio, (-lim0 - x0) / s0);
        if (x1 + s1 > lim1) ratio = Math.min(ratio, (lim1 - x1) / s1);
        else if (x1 + s1 < -lim1) ratio = Math.min(ratio, (-lim1 - x1) / s1);
        if (x2 + s2 > lim2) ratio = Math.min(ratio, (lim2 - x2) / s2);
        else if (x2 + s2 < -lim2) ratio = Math.min(ratio, (-lim2 - x2) / s2);
        if (mag > maxError2) ratio *= 0.8;
        if (ratio < 0) ratio = 0;
        s0 *= ratio;
        s1 *= ratio;
        s2 *= ratio;
        s3 *= ratio;
        t0 += s0;
        t1 += s1;
        t2 += s2;
        t3 += s3;
      }
      const j = nn.nearest(t0, t1, t2, t3, guess ? guess[i] : last);
      indices[i] = j;
      last = j;
      const q = j * DIM;
      let d0 = t0 - coords[q];
      let d1 = t1 - coords[q + 1];
      let d2 = t2 - coords[q + 2];
      let d3 = t3 - coords[q + 3];
      if (d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3 > maxError2) {
        d0 *= 0.75;
        d1 *= 0.75;
        d2 *= 0.75;
        d3 *= 0.75;
      }
      // 7/16 ahead, 3/16 behind-below, 5/16 below, 1/16 ahead-below.
      const ahead = e + dir * DIM;
      const behind = e - dir * DIM;
      cur[ahead] += d0 * 0.4375;
      cur[ahead + 1] += d1 * 0.4375;
      cur[ahead + 2] += d2 * 0.4375;
      cur[ahead + 3] += d3 * 0.4375;
      next[behind] += d0 * 0.1875;
      next[behind + 1] += d1 * 0.1875;
      next[behind + 2] += d2 * 0.1875;
      next[behind + 3] += d3 * 0.1875;
      next[e] += d0 * 0.3125;
      next[e + 1] += d1 * 0.3125;
      next[e + 2] += d2 * 0.3125;
      next[e + 3] += d3 * 0.3125;
      next[ahead] += d0 * 0.0625;
      next[ahead + 1] += d1 * 0.0625;
      next[ahead + 2] += d2 * 0.0625;
      next[ahead + 3] += d3 * 0.0625;
    }
    const swap = cur;
    cur = next;
    next = swap;
  }
  return indices;
}
