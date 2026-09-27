/**
 * Minimal PNG writers (no metadata chunks: IHDR, PLTE, tRNS, IDAT, IEND only).
 *
 * - `encodeIndexedPng`: colour type 3 at the smallest bit depth for the palette (1/2/4/8). Unused
 *   entries are dropped; entries with alpha < 255 are ordered first so tRNS stops at the last
 *   non-opaque one.
 * - `encodeTruecolorPng`: lossless re-encode, colour type 2 when fully opaque, 6 otherwise. RGB of
 *   fully transparent pixels is zeroed (invisible, compresses better).
 * Row filters (none / sub / up / paeth / adaptive = libpng's minimum-sum-of-absolute-differences per
 * row) and zlib strategies are given as a list of attempts; the smallest IDAT wins. IDAT is zlib
 * (pako) at the given level.
 */
import { zlibDeflate, Z_DEFAULT_STRATEGY, Z_FILTERED } from './zlib';

// ─── CRC-32 / chunks ─────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (PNG / zlib polynomial) of data[start..end). */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = bitDepth;
  d[9] = colorType;
  // compression 0, filter method 0, interlace 0
  return chunk('IHDR', d);
}

function assemble(chunks: Uint8Array[]): Uint8Array {
  const total = SIGNATURE.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let o = SIGNATURE.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export type FilterMode = 'none' | 'adaptive' | 'sub' | 'up' | 'paeth';

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Applies filter `type` to one row into out[o + 1 ..], writing the type byte at out[o]. */
function filterRow(type: number, raw: Uint8Array, row: number, prev: number, rowBytes: number, bpp: number, out: Uint8Array, o: number): void {
  out[o] = type;
  const d = o + 1;
  switch (type) {
    case 0:
      out.set(raw.subarray(row, row + rowBytes), d);
      break;
    case 1:
      for (let i = 0; i < rowBytes; i++) out[d + i] = (raw[row + i] - (i >= bpp ? raw[row + i - bpp] : 0)) & 255;
      break;
    case 2:
      for (let i = 0; i < rowBytes; i++) out[d + i] = (raw[row + i] - (prev >= 0 ? raw[prev + i] : 0)) & 255;
      break;
    case 3:
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? raw[row + i - bpp] : 0;
        const b = prev >= 0 ? raw[prev + i] : 0;
        out[d + i] = (raw[row + i] - ((a + b) >> 1)) & 255;
      }
      break;
    default:
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? raw[row + i - bpp] : 0;
        const b = prev >= 0 ? raw[prev + i] : 0;
        const c = i >= bpp && prev >= 0 ? raw[prev + i - bpp] : 0;
        out[d + i] = (raw[row + i] - paeth(a, b, c)) & 255;
      }
  }
}

/**
 * Filtered scanlines (type byte + data per row) for `raw` (height × rowBytes). With `rows`, only
 * those rows are filtered (each still predicted from its real previous row) and concatenated.
 */
export function filterImage(raw: Uint8Array, rowBytes: number, height: number, bpp: number, mode: FilterMode, rows?: readonly number[]): Uint8Array {
  const stride = rowBytes + 1;
  const count = rows ? rows.length : height;
  const out = new Uint8Array(stride * count);
  const fixed = mode === 'none' ? 0 : mode === 'sub' ? 1 : mode === 'up' ? 2 : mode === 'paeth' ? 4 : -1;
  const trial = fixed < 0 ? new Uint8Array(stride) : null;
  for (let k = 0; k < count; k++) {
    const y = rows ? rows[k] : k;
    const row = y * rowBytes;
    const prev = y > 0 ? row - rowBytes : -1;
    if (fixed >= 0) {
      filterRow(fixed, raw, row, prev, rowBytes, bpp, out, k * stride);
      continue;
    }
    // Minimum sum of absolute (signed) values.
    let bestSum = Infinity;
    for (let type = 0; type < 5; type++) {
      filterRow(type, raw, row, prev, rowBytes, bpp, trial!, 0);
      let sum = 0;
      for (let i = 1; i < stride && sum < bestSum; i++) {
        const v = trial![i];
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        out.set(trial!, k * stride);
      }
    }
  }
  return out;
}

export interface EncodeAttempt {
  filter: FilterMode;
  /** zlib strategy: 'default' or 'filtered'. */
  strategy: 'default' | 'filtered';
}

export interface PngEncodeOptions {
  /** zlib level 0..9 of the written IDAT. */
  level: number;
  /** zlib memLevel 1..9 (default 9). */
  memLevel?: number;
  /** Filter / strategy candidates; the smallest output is kept. */
  attempts: readonly EncodeAttempt[];
  /**
   * With several attempts: rank them by their size at this (fast) zlib level and deflate only the
   * winner at `level`. Omit to deflate every attempt at `level`.
   */
  rankLevel?: number;
  /**
   * Rank on at most about this many bytes of scanlines (bands of rows spread over the image) instead
   * of the whole image. Default: the whole image.
   */
  rankSampleBytes?: number;
}

const RANK_BAND_ROWS = 16;

/** Rows of evenly spread bands of RANK_BAND_ROWS rows, about `budget` bytes in total. */
function sampleRows(height: number, rowBytes: number, budget: number): number[] | undefined {
  const wanted = Math.max(RANK_BAND_ROWS, Math.floor(budget / (rowBytes + 1)));
  if (wanted >= height) return undefined;
  const bands = Math.max(1, Math.floor(wanted / RANK_BAND_ROWS));
  const rows: number[] = [];
  for (let b = 0; b < bands; b++) {
    const start = Math.floor(((b + 0.5) * height) / bands - RANK_BAND_ROWS / 2);
    for (let y = Math.max(0, start); y < Math.min(height, start + RANK_BAND_ROWS); y++) if (rows.length === 0 || y > rows[rows.length - 1]) rows.push(y);
  }
  return rows;
}

function strategyOf(a: EncodeAttempt): number {
  return a.strategy === 'filtered' ? Z_FILTERED : Z_DEFAULT_STRATEGY;
}

function compressScanlines(raw: Uint8Array, rowBytes: number, height: number, bpp: number, options: PngEncodeOptions): Uint8Array {
  const attempts = options.attempts.length > 0 ? options.attempts : [{ filter: 'none', strategy: 'default' } as const];
  const filtered = new Map<FilterMode, Uint8Array>();
  const scanlines = (mode: FilterMode): Uint8Array => {
    let data = filtered.get(mode);
    if (!data) {
      data = filterImage(raw, rowBytes, height, bpp, mode);
      filtered.set(mode, data);
    }
    return data;
  };
  const memLevel = options.memLevel;
  if (attempts.length === 1) return zlibDeflate(scanlines(attempts[0].filter), { level: options.level, memLevel, strategy: strategyOf(attempts[0]) });
  const rank = options.rankLevel;
  const sample = rank !== undefined && options.rankSampleBytes !== undefined ? sampleRows(height, rowBytes, options.rankSampleBytes) : undefined;
  let best: { attempt: EncodeAttempt; bytes: Uint8Array } | null = null;
  for (const a of attempts) {
    const data = sample ? filterImage(raw, rowBytes, height, bpp, a.filter, sample) : scanlines(a.filter);
    const z = zlibDeflate(data, { level: rank ?? options.level, memLevel, strategy: strategyOf(a) });
    if (!best || z.length < best.bytes.length) best = { attempt: a, bytes: z };
  }
  if (!sample && (rank === undefined || rank === options.level)) return best!.bytes;
  return zlibDeflate(scanlines(best!.attempt.filter), { level: options.level, memLevel, strategy: strategyOf(best!.attempt) });
}

// ─── Indexed ─────────────────────────────────────────────────────────────────

/** Smallest PNG bit depth for a palette of `size` entries. */
export function bitDepthFor(size: number): 1 | 2 | 4 | 8 {
  return size <= 2 ? 1 : size <= 4 ? 2 : size <= 16 ? 4 : 8;
}

/**
 * Palette order for the file: entries with alpha < 255 first (by alpha, then luma), opaque entries
 * after (by luma). Returns the new order (old indices).
 */
function paletteOrder(palette: Uint8Array, used: readonly number[]): number[] {
  const luma = (i: number): number => 299 * palette[i * 4] + 587 * palette[i * 4 + 1] + 114 * palette[i * 4 + 2];
  return [...used].sort((i, j) => {
    const ai = palette[i * 4 + 3];
    const aj = palette[j * 4 + 3];
    if (ai !== aj) return ai - aj; // opaque (255) last
    return luma(i) - luma(j) || i - j;
  });
}

export interface IndexedPngInfo {
  bytes: Uint8Array;
  /** Palette entries written. */
  colors: number;
  bitDepth: number;
  /** tRNS entries written (0 = no tRNS chunk). */
  transparentEntries: number;
}

/**
 * Indexed PNG from palette indices (one byte per pixel) and a straight RGBA palette
 * (`paletteSize` entries, 4 bytes each).
 */
export function encodeIndexedPng(indices: Uint8Array, width: number, height: number, palette: Uint8Array, paletteSize: number, options: PngEncodeOptions): IndexedPngInfo {
  const n = width * height;
  if (indices.length < n) throw new RangeError('indices shorter than width × height');
  const counts = new Uint32Array(256);
  for (let i = 0; i < n; i++) counts[indices[i]]++;
  const used: number[] = [];
  for (let i = 0; i < paletteSize; i++) if (counts[i] > 0) used.push(i);
  for (let i = paletteSize; i < 256; i++) if (counts[i] > 0) throw new RangeError(`index ${i} outside the palette`);
  if (used.length === 0) used.push(0);

  const order = paletteOrder(palette, used);
  const lut = new Uint8Array(256);
  order.forEach((old, i) => (lut[old] = i));
  const size = order.length;
  const depth = bitDepthFor(size);

  const plte = new Uint8Array(size * 3);
  let trnsLen = 0;
  order.forEach((old, i) => {
    plte[i * 3] = palette[old * 4];
    plte[i * 3 + 1] = palette[old * 4 + 1];
    plte[i * 3 + 2] = palette[old * 4 + 2];
    if (palette[old * 4 + 3] !== 255) trnsLen = i + 1;
  });
  const trns = new Uint8Array(trnsLen);
  for (let i = 0; i < trnsLen; i++) trns[i] = palette[order[i] * 4 + 3];

  const rowBytes = Math.ceil((width * depth) / 8);
  const raw = new Uint8Array(rowBytes * height);
  const perByte = 8 / depth;
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * rowBytes;
    if (depth === 8) {
      for (let x = 0; x < width; x++) raw[dst + x] = lut[indices[src + x]];
    } else {
      for (let x = 0; x < width; x++) {
        const shift = 8 - depth * ((x % perByte) + 1);
        raw[dst + ((x / perByte) | 0)] |= lut[indices[src + x]] << shift;
      }
    }
  }
  const idat = compressScanlines(raw, rowBytes, height, 1, options);
  const chunks = [ihdr(width, height, depth, 3), chunk('PLTE', plte)];
  if (trnsLen > 0) chunks.push(chunk('tRNS', trns));
  chunks.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return { bytes: assemble(chunks), colors: size, bitDepth: depth, transparentEntries: trnsLen };
}

// ─── Truecolour ──────────────────────────────────────────────────────────────

/** Lossless RGB / RGBA PNG (colour type 2 when every pixel is opaque, 6 otherwise). */
export function encodeTruecolorPng(rgba: Uint8Array, width: number, height: number, options: PngEncodeOptions): Uint8Array {
  const n = width * height;
  let opaque = true;
  for (let i = 3; i < n * 4; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const bpp = opaque ? 3 : 4;
  const rowBytes = width * bpp;
  const raw = new Uint8Array(rowBytes * height);
  if (opaque) {
    for (let i = 0, o = 0; i < n * 4; i += 4, o += 3) {
      raw[o] = rgba[i];
      raw[o + 1] = rgba[i + 1];
      raw[o + 2] = rgba[i + 2];
    }
  } else {
    raw.set(rgba.subarray(0, n * 4));
    for (let i = 3; i < n * 4; i += 4) {
      if (raw[i] === 0) {
        raw[i - 3] = 0;
        raw[i - 2] = 0;
        raw[i - 1] = 0;
      }
    }
  }
  const idat = compressScanlines(raw, rowBytes, height, bpp, options);
  return assemble([ihdr(width, height, 8, opaque ? 2 : 6), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}
