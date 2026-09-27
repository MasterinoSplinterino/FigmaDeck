/**
 * TinyPNG / pngquant-style PNG compression, environment-neutral (browser UI and Node tests; no DOM,
 * no Node built-ins).
 *
 * - `compressRgba`: lossy ≤256-colour palette PNG with adaptive dithering behind a quality gate
 *   (pngquant `--quality min-max` analogue). Images with ≤ maxColors distinct colours get an exact
 *   palette (lossless). Returns null when no palette passes the gate: keep the lossless bitmap.
 * - `optimizeLossless`: exact palette when possible, else a re-encoded RGB/RGBA PNG (metadata dropped).
 * - `hasTransparency`, `countColors`: cheap scans for the caller's per-asset decision.
 *
 * Pipeline of a lossy attempt: block activity → importance-weighted histogram (sampled above
 * CONFIG.compress.maxPixels) → median cut + k-means (quantize.ts) → plain remap → adaptive dither
 * map → Floyd–Steinberg remap (dither.ts) → metrics (metrics.ts) → gate. While banding is above the
 * level's target, feedback rounds re-weight the histogram towards the blocks the palette serves
 * worst. Tunables: CONFIG.compress. Evidence and timings: scripts/compress-bench.ts.
 *
 * Timing (Node 22, one core; the browser is similar): compressRgba ≈ 0.7–2 s for a 1 MP bitmap
 * (feedback rounds included), ≈ 1–1.3 s at 2.5 MP, ≈ 12–17 s at 30 MP (sampled histogram, a single
 * attempt); optimizeLossless ≈ 0.6–1.6 s at 1–2.5 MP, ≈ 16 s at 30 MP. Everything is synchronous:
 * run it in a Worker, or at least yield to the event loop between assets.
 */
import { CONFIG } from '../config';
import { ditherMap, remapDither, remapNearest } from './dither';
import { buildHistogram, type Histogram } from './histogram';
import { blockActivity, blockImportance, type BlockWeights } from './importance';
import { measureQuality, type QualityMetrics } from './metrics';
import { NearestSearch } from './nearest';
import { encodeIndexedPng, encodeTruecolorPng, type EncodeAttempt, type PngEncodeOptions } from './png-encode';
import { exactPalette, paletteCoords, quantize, type Palette } from './quantize';
import { makeColorSpace, type ColorSpace } from './space';

export type { QualityMetrics } from './metrics';
export { measureQuality } from './metrics';

export type CompressLevel = 'balanced' | 'strong';

/** Straight RGBA, 4 bytes per pixel, row-major (canvas `ImageData.data` can be passed as is). */
export type RgbaPixels = Uint8Array | Uint8ClampedArray;

/** Zero-copy byte view of the pixels. */
function bytesOf(rgba: RgbaPixels): Uint8Array {
  return rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);
}

export interface QualityThresholds {
  /** Minimum PSNR (dB, premultiplied RGBA, visible pixels). */
  minPsnr: number;
  /** Minimum SSIM after a 2×2 downscale (`QualityMetrics.ssimHalf`: 8×8 blocks, luma over black and over white). */
  minSsim: number;
  /** Maximum `QualityMetrics.banding` (8-bit levels): the banding guard. */
  maxBanding: number;
}

export interface CompressOptions {
  /** Upper bound of the palette size, 2..256 (default 256). */
  maxColors?: number;
  /** Dither strength 0..1 (default: the level's). */
  dither?: number;
  /** Quality gate overrides (default: the level's). */
  thresholds?: Partial<QualityThresholds>;
  /**
   * Also try all of CONFIG.compress.smallerPalettes (default: for flat graphics and small images;
   * otherwise the level's own `smallerPalettes`).
   */
  trySmallerPalettes?: boolean;
  /** Return null unless the result is smaller than this many bytes (e.g. the current PNG's size). */
  maxBytes?: number;
}

export interface PaletteAttempt {
  colors: number;
  passed: boolean;
  /** Size estimate at the fast ranking zlib level (0 when the gate failed or nothing to compare). */
  estimatedBytes: number;
  psnr: number;
  ssim: number;
  ssimHalf: number;
  banding: number;
  /** Feedback rounds kept. */
  feedbackRounds: number;
}

export interface CompressResult {
  bytes: Uint8Array;
  /** Palette entries written. */
  colors: number;
  /** dB (Infinity when lossless). */
  psnr: number;
  /** The gated SSIM (`metrics.ssimHalf`, 1 when lossless); full-resolution SSIM is `metrics.ssim`. */
  ssim?: number;
  method: 'palette';
  /** Exact palette: pixel-identical to the input (alpha-0 pixels normalised to transparent black). */
  lossless: boolean;
  bitDepth: number;
  /** Full metrics of the kept result (null when lossless). */
  metrics: QualityMetrics | null;
  /** Palette sizes tried, in order. */
  attempts: PaletteAttempt[];
}

type CompressConfig = typeof CONFIG.compress;

function checkInput(rgba: RgbaPixels, width: number, height: number): void {
  if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height)) throw new RangeError(`bad size ${width}×${height}`);
  if (rgba.length < width * height * 4) throw new RangeError('rgba shorter than width × height × 4');
}

function paletteOptions(cfg: CompressConfig, pixels: number, level?: number): PngEncodeOptions {
  const final = pixels > cfg.fastDeflatePixels ? cfg.fastDeflateLevel : cfg.deflateLevel;
  return { level: level ?? final, memLevel: cfg.deflateMemLevel, attempts: cfg.paletteAttempts as readonly EncodeAttempt[], rankLevel: cfg.rankDeflateLevel };
}

function truecolorOptions(cfg: CompressConfig): PngEncodeOptions {
  return { level: cfg.truecolorDeflateLevel, attempts: cfg.truecolorAttempts as readonly EncodeAttempt[], rankLevel: cfg.rankDeflateLevel, rankSampleBytes: cfg.rankSampleBytes };
}

/** True when any pixel is not fully opaque. */
export function hasTransparency(rgba: RgbaPixels): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

function hasZeroAlpha(rgba: Uint8Array, n: number): boolean {
  for (let i = 3; i < n * 4; i += 4) if (rgba[i] === 0) return true;
  return false;
}

/**
 * Number of distinct RGBA colours (all fully transparent pixels count as one), counting stops at
 * `limit + 1`: a return value > limit means "more than limit".
 */
export function countColors(pixels: RgbaPixels, limit: number): number {
  const rgba = bytesOf(pixels);
  const seen = new Set<number>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3];
    seen.add(a === 0 ? 0 : (rgba[i] | (rgba[i + 1] << 8) | (rgba[i + 2] << 16) | (a << 24)) >>> 0);
    if (seen.size > limit) return limit + 1;
  }
  return seen.size;
}

/** Lossless re-encode: exact palette when ≤256 colours, else RGB/RGBA with the best row filters. */
export function optimizeLossless(rgba: RgbaPixels, width: number, height: number): Uint8Array {
  checkInput(rgba, width, height);
  const cfg = CONFIG.compress;
  const pixels = bytesOf(rgba).subarray(0, width * height * 4);
  const exact = exactPalette(pixels, 256);
  if (exact) return encodeIndexedPng(exact.indices, width, height, exact.palette.rgba, exact.palette.size, paletteOptions(cfg, width * height)).bytes;
  return encodeTruecolorPng(pixels, width, height, truecolorOptions(cfg));
}

// ─── Lossy palette ───────────────────────────────────────────────────────────

function passes(m: QualityMetrics, t: QualityThresholds): boolean {
  return m.psnr >= t.minPsnr && m.ssimHalf >= t.minSsim && m.banding <= t.maxBanding;
}

/** Everything a palette attempt needs about the image (computed once). */
interface Context {
  rgba: Uint8Array;
  width: number;
  height: number;
  space: ColorSpace;
  activity: Float32Array;
  importance: BlockWeights;
  /** Histogram with `importance` (shared by the first round of every palette size). */
  hist: Histogram;
  step: number;
  strength: number;
  thresholds: QualityThresholds;
  targetBanding: number;
  feedbackRounds: number;
  cfg: CompressConfig;
}

interface Rendition {
  palette: Palette;
  indices: Uint8Array;
  metrics: QualityMetrics;
  blockErrors: Float32Array;
}

/** Quantize the histogram to `colors`, remap (dithered) and measure. */
function render(ctx: Context, hist: Histogram, colors: number): Rendition {
  const { rgba, width, height, space, cfg } = ctx;
  const palette = quantize(hist, space, {
    colors,
    kmeansIterations: cfg.kmeansIterations,
    kmeansMinImprovement: cfg.kmeansMinImprovement,
    snapMinShare: cfg.snapMinShare,
    snapMaxDistance: cfg.snapMaxDistance,
  });
  const coords = paletteCoords(space, palette);
  const search = new NearestSearch(coords, palette.size);
  const plain = remapNearest(rgba, width, height, space, palette, coords, search);
  let indices = plain.indices;
  if (ctx.strength > 0) {
    const out = new Uint8Array(width * height);
    const map = cfg.dither.adaptive ? ditherMap(rgba, width, height, plain.indices, { edgeScale: cfg.dither.edgeScale }, out) : null;
    const options = {
      strength: ctx.strength,
      map,
      guess: plain.indices,
      minError2: cfg.dither.minError2,
      maxError2: Math.max(cfg.dither.maxErrorFactor * plain.mse, cfg.dither.maxErrorMin),
      overflow: cfg.dither.overflow,
    };
    indices = remapDither(rgba, width, height, space, palette, coords, options, search, out);
  }
  const blockErrors = new Float32Array(ctx.activity.length);
  const metrics = measureQuality(rgba, width, height, { indices, palette: palette.rgba }, { activity: ctx.activity, maskActivity: cfg.maskActivity, blockErrorsOut: blockErrors });
  return { palette, indices, metrics, blockErrors };
}

/**
 * One palette size. While the gate fails or banding is above the level's target, feedback rounds
 * boost the histogram weight of the blocks with the largest masked mean error (colours the palette
 * serves badly in smooth areas) and quantize again. A round is kept when it makes the gate pass, or
 * lowers banding without costing more than the allowed PSNR / SSIM (libimagequant's feedback loop,
 * driven by the visible-error metric instead of the plain error).
 */
function tryPalette(ctx: Context, colors: number): { rendition: Rendition; passed: boolean; rounds: number } {
  const { cfg, thresholds } = ctx;
  const fb = cfg.feedback;
  let best = render(ctx, ctx.hist, colors);
  let weights = ctx.importance;
  let rounds = 0;
  for (let round = 0; round < ctx.feedbackRounds; round++) {
    const m = best.metrics;
    const passed = passes(m, thresholds);
    if (passed && m.banding <= ctx.targetBanding) break;
    // Feedback trades a little PSNR for smooth-area fidelity: it cannot fix a PSNR shortfall.
    if (m.psnr < thresholds.minPsnr) break;
    const boosted = new Float32Array(weights.map.length);
    for (let b = 0; b < boosted.length; b++) {
      const e = best.blockErrors[b];
      const r = e > fb.minError ? e / fb.scale : 0;
      boosted[b] = weights.map[b] * (1 + r * r);
    }
    weights = { map: boosted, blocksWide: weights.blocksWide };
    const hist = buildHistogram(ctx.rgba, ctx.width, ctx.height, ctx.space, { maxEntries: cfg.maxHistogramColors, step: ctx.step, importance: weights });
    hist.hasTransparent = ctx.hist.hasTransparent;
    const next = render(ctx, hist, colors);
    const nm = next.metrics;
    const better = nm.banding < m.banding && nm.psnr >= m.psnr - fb.maxPsnrLoss && nm.ssimHalf >= m.ssimHalf - fb.maxSsimLoss;
    if (!better && !(passes(nm, thresholds) && !passed)) break;
    best = next;
    rounds++;
  }
  return { rendition: best, passed: passes(best.metrics, thresholds), rounds };
}

/**
 * Lossy palette PNG behind a quality gate, or null when the gate fails (keep the lossless bitmap).
 * `rgba` is straight (non-premultiplied) RGBA as returned by canvas getImageData (not modified).
 * Deterministic: the same input and options always give the same bytes.
 */
export function compressRgba(rgba: RgbaPixels, width: number, height: number, level: CompressLevel, opts: CompressOptions = {}): CompressResult | null {
  checkInput(rgba, width, height);
  const cfg = CONFIG.compress;
  const lv = cfg.levels[level];
  const n = width * height;
  const pixels = bytesOf(rgba).subarray(0, n * 4);
  const maxColors = Math.max(2, Math.min(256, Math.floor(opts.maxColors ?? 256)));

  const exact = exactPalette(pixels, maxColors);
  if (exact) {
    const png = encodeIndexedPng(exact.indices, width, height, exact.palette.rgba, exact.palette.size, paletteOptions(cfg, n));
    if (opts.maxBytes !== undefined && png.bytes.length >= opts.maxBytes) return null;
    return { bytes: png.bytes, colors: png.colors, psnr: Infinity, ssim: 1, method: 'palette', lossless: true, bitDepth: png.bitDepth, metrics: null, attempts: [] };
  }

  const thresholds: QualityThresholds = {
    minPsnr: opts.thresholds?.minPsnr ?? lv.minPsnr,
    minSsim: opts.thresholds?.minSsim ?? lv.minSsim,
    maxBanding: opts.thresholds?.maxBanding ?? lv.maxBanding,
  };
  const space = makeColorSpace(cfg.channelWeights);
  const step = n > cfg.maxPixels ? Math.ceil(Math.sqrt(n / cfg.samplePixels)) : 1;
  const activity = blockActivity(pixels, width, height);
  const importance = blockImportance(activity, width, cfg.importance);
  const hist = buildHistogram(pixels, width, height, space, { maxEntries: cfg.maxHistogramColors, step, importance });
  if (!hist.hasTransparent && hasZeroAlpha(pixels, n)) hist.hasTransparent = true; // missed by sampling
  const ctx: Context = {
    rgba: pixels,
    width,
    height,
    space,
    activity,
    importance,
    hist,
    step,
    strength: Math.max(0, Math.min(1, opts.dither ?? lv.ditherStrength)),
    thresholds,
    targetBanding: Math.min(lv.targetBanding, thresholds.maxBanding),
    feedbackRounds: n > cfg.retryMaxPixels ? 0 : cfg.feedback.rounds,
    cfg,
  };

  const flat = countColors(pixels, cfg.flatMaxColors) <= cfg.flatMaxColors;
  const all = opts.trySmallerPalettes ?? (flat || n <= cfg.smallImagePixels);
  const extra = all ? cfg.smallerPalettes : n > cfg.retryMaxPixels ? [] : lv.smallerPalettes;
  const sizes = [maxColors, ...extra.filter((s) => s < maxColors)];

  // Candidates are ranked by a fast deflate; only the winner is written at the final zlib level.
  let best: { rendition: Rendition; estimate: number } | null = null;
  const attempts: PaletteAttempt[] = [];
  for (const colors of sizes) {
    const c = tryPalette(ctx, colors);
    const m = c.rendition.metrics;
    const estimate = c.passed && sizes.length > 1 ? encodeIndexedPng(c.rendition.indices, width, height, c.rendition.palette.rgba, c.rendition.palette.size, paletteOptions(cfg, n, cfg.rankDeflateLevel)).bytes.length : 0;
    attempts.push({ colors, passed: c.passed, estimatedBytes: estimate, psnr: m.psnr, ssim: m.ssim, ssimHalf: m.ssimHalf, banding: m.banding, feedbackRounds: c.rounds });
    if (!c.passed) break; // fewer colours will not do better
    if (!best || estimate < best.estimate) best = { rendition: c.rendition, estimate };
  }
  if (!best) return null;
  const { palette, indices, metrics } = best.rendition;
  const png = encodeIndexedPng(indices, width, height, palette.rgba, palette.size, paletteOptions(cfg, n));
  if (opts.maxBytes !== undefined && png.bytes.length >= opts.maxBytes) return null;
  return {
    bytes: png.bytes,
    colors: png.colors,
    psnr: metrics.psnr,
    ssim: metrics.ssimHalf,
    method: 'palette',
    lossless: false,
    bitDepth: png.bitDepth,
    metrics,
    attempts,
  };
}
