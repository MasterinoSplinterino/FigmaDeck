/**
 * Quality metrics between an original RGBA bitmap and its compressed version, in premultiplied
 * space (what a viewer composites). Fully transparent pixels (in both images) are left out, so a
 * mostly empty layer is not rated by its empty area.
 *
 * - `mse` / `psnr`: per channel over premultiplied R, G, B and A (8-bit levels).
 * - `ssim`: mean SSIM of 8×8 blocks on luma composited over black and over white (the lower of the
 *   two). `ssimHalf`: the same after a 2×2 box downscale (what a 2× export shows at 1×; fine dither
 *   noise averages out there, lost structure does not).
 * - Block errors: for each 8×8 block the signed mean error of every channel composited over black
 *   and over white, and of alpha (7 values, 8-bit levels). Dithering keeps block means right (error
 *   diffusion conserves the local mean); flat bands and hue shifts do not. Texture masks errors, so
 *   values are divided by (1 + activity / maskActivity), activity being the block's mean |second
 *   difference| in the original (≈ 0 for flat areas and linear gradients).
 *   - `banding` (gated) / `bandingMax`: 99.9th percentile / max over horizontally and vertically
 *     adjacent block pairs of the largest change of those signed errors. Visible banding is a jump
 *     of the error between neighbouring areas (a band edge); a uniform offset, which is invisible,
 *     scores 0, and so does well-behaved dither noise.
 *   - `maxBlockError` / `p99BlockError`: largest / 99th percentile of a block's own |mean error|
 *     (colour shifts; also drives the feedback loop).
 */
import { blockActivity } from './importance';

export interface QualityMetrics {
  mse: number;
  /** dB; Infinity when identical. */
  psnr: number;
  /** Full-resolution 8×8-block SSIM. */
  ssim: number;
  /** SSIM after a 2×2 downscale (gated). */
  ssimHalf: number;
  /** 99.9th percentile of the masked jump of block mean errors between adjacent blocks (8-bit levels). */
  banding: number;
  bandingMax: number;
  maxBlockError: number;
  p99BlockError: number;
  /** Pixels compared (visible in either image). */
  pixels: number;
}

/** The compressed image: straight RGBA, or palette indices + straight RGBA palette. */
export type MetricsSource = Uint8Array | { indices: Uint8Array; palette: Uint8Array };

export interface MetricsOptions {
  /** Activity (8-bit levels) that halves a block's error (texture masking). */
  maskActivity?: number;
  /** Precomputed `blockActivity(orig)`. */
  activity?: Float32Array;
  /** When given (length ≥ blocks), receives each 8×8 block's masked error (row-major; 0 for empty blocks). */
  blockErrorsOut?: Float32Array;
}

const BLOCK = 8;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const KR = 0.299;
const KG = 0.587;
const KB = 0.114;

export function psnrFromMse(mse: number): number {
  return mse > 0 ? 10 * Math.log10((255 * 255) / mse) : Infinity;
}

function ssimBlock(mx: number, my: number, mxx: number, myy: number, mxy: number): number {
  const vx = Math.max(0, mxx - mx * mx);
  const vy = Math.max(0, myy - my * my);
  const cxy = mxy - mx * my;
  return ((2 * mx * my + C1) * (2 * cxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
}

/** Reads the result's straight RGBA of pixel i into out[0..3]. */
type Reader = (i: number, out: Float64Array) => void;

function reader(result: MetricsSource): Reader {
  if (result instanceof Uint8Array) {
    return (i, out) => {
      const p = i * 4;
      out[0] = result[p];
      out[1] = result[p + 1];
      out[2] = result[p + 2];
      out[3] = result[p + 3];
    };
  }
  const { indices, palette } = result;
  return (i, out) => {
    const q = indices[i] * 4;
    out[0] = palette[q];
    out[1] = palette[q + 1];
    out[2] = palette[q + 2];
    out[3] = palette[q + 3];
  };
}

export function measureQuality(orig: Uint8Array, width: number, height: number, result: MetricsSource, options: MetricsOptions = {}): QualityMetrics {
  const read = reader(result);
  const maskActivity = options.maskActivity ?? 0.5;
  const activity = options.activity ?? blockActivity(orig, width, height);
  const bw = Math.ceil(width / BLOCK);
  const bh = Math.ceil(height / BLOCK);
  const blockErrors = new Float32Array(bw * bh);
  // Signed, masked mean errors per block (7 composites), NaN for blocks with nothing visible.
  const signed = new Float32Array(bw * bh * 7).fill(NaN);
  const px = new Float64Array(4);
  let blocks = 0;
  let sse = 0;
  let pixels = 0;
  let ssimB = 0;
  let ssimW = 0;
  let maxBlock = 0;

  for (let by = 0; by < bh; by++) {
    const y0 = by * BLOCK;
    const y1 = Math.min(height, y0 + BLOCK);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * BLOCK;
      const x1 = Math.min(width, x0 + BLOCK);
      let n = 0;
      let visible = 0;
      let sob = 0, srb = 0, soob = 0, srrb = 0, sorb = 0;
      let sow = 0, srw = 0, soow = 0, srrw = 0, sorw = 0;
      let dr = 0, dg = 0, db = 0, da = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x;
          const p = i * 4;
          read(i, px);
          const ao = orig[p + 3];
          const ra = px[3];
          n++;
          const fo = ao / 255;
          const fr = ra / 255;
          const or = orig[p] * fo;
          const og = orig[p + 1] * fo;
          const ob = orig[p + 2] * fo;
          const pr = px[0] * fr;
          const pg = px[1] * fr;
          const pb = px[2] * fr;
          const er = or - pr;
          const eg = og - pg;
          const eb = ob - pb;
          const ea = ao - ra;
          if (ao !== 0 || ra !== 0) {
            visible++;
            sse += er * er + eg * eg + eb * eb + ea * ea;
          }
          dr += er;
          dg += eg;
          db += eb;
          da += ea;
          const yob = KR * or + KG * og + KB * ob;
          const yrb = KR * pr + KG * pg + KB * pb;
          const yow = yob + 255 - ao;
          const yrw = yrb + 255 - ra;
          sob += yob;
          srb += yrb;
          soob += yob * yob;
          srrb += yrb * yrb;
          sorb += yob * yrb;
          sow += yow;
          srw += yrw;
          soow += yow * yow;
          srrw += yrw * yrw;
          sorw += yow * yrw;
        }
      }
      if (visible === 0) {
        if (options.blockErrorsOut) options.blockErrorsOut[by * bw + bx] = 0;
        continue;
      }
      pixels += visible;
      const inv = 1 / n;
      ssimB += ssimBlock(sob * inv, srb * inv, soob * inv, srrb * inv, sorb * inv);
      ssimW += ssimBlock(sow * inv, srw * inv, soow * inv, srrw * inv, sorw * inv);
      // Over black: Δc; over white: Δc − Δa (premultiplied), plus Δa itself.
      const mask = inv / (1 + activity[by * bw + bx] / maskActivity);
      const o7 = (by * bw + bx) * 7;
      signed[o7] = dr * mask;
      signed[o7 + 1] = dg * mask;
      signed[o7 + 2] = db * mask;
      signed[o7 + 3] = (dr - da) * mask;
      signed[o7 + 4] = (dg - da) * mask;
      signed[o7 + 5] = (db - da) * mask;
      signed[o7 + 6] = da * mask;
      const masked = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db), Math.abs(dr - da), Math.abs(dg - da), Math.abs(db - da), Math.abs(da)) * mask;
      blockErrors[blocks++] = masked;
      if (options.blockErrorsOut) options.blockErrorsOut[by * bw + bx] = masked;
      if (masked > maxBlock) maxBlock = masked;
    }
  }
  const mse = pixels > 0 ? sse / (pixels * 4) : 0;
  const band = bandingStats(signed, bw, bh);
  let p99 = 0;
  if (blocks > 0) {
    const sorted = blockErrors.subarray(0, blocks).sort();
    p99 = sorted[Math.min(blocks - 1, Math.floor(blocks * 0.99))];
  }
  return {
    mse,
    psnr: psnrFromMse(mse),
    ssim: blocks > 0 ? Math.min(ssimB, ssimW) / blocks : 1,
    ssimHalf: ssimHalf(orig, width, height, read),
    banding: band.p999,
    bandingMax: band.max,
    maxBlockError: maxBlock,
    p99BlockError: p99,
    pixels,
  };
}

/** Largest change of the signed block errors between adjacent visible blocks: 99.9th percentile and max. */
function bandingStats(signed: Float32Array, bw: number, bh: number): { p999: number; max: number } {
  const jumps = new Float32Array(bw * bh * 2);
  let n = 0;
  let max = 0;
  const jump = (a: number, b: number): number => {
    let g = 0;
    for (let k = 0; k < 7; k++) {
      const d = Math.abs(signed[a * 7 + k] - signed[b * 7 + k]);
      if (d > g) g = d;
    }
    return g;
  };
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const b = by * bw + bx;
      if (Number.isNaN(signed[b * 7])) continue;
      if (bx + 1 < bw && !Number.isNaN(signed[(b + 1) * 7])) {
        const g = jump(b, b + 1);
        jumps[n++] = g;
        if (g > max) max = g;
      }
      if (by + 1 < bh && !Number.isNaN(signed[(b + bw) * 7])) {
        const g = jump(b, b + bw);
        jumps[n++] = g;
        if (g > max) max = g;
      }
    }
  }
  if (n === 0) return { p999: 0, max: 0 };
  const sorted = jumps.subarray(0, n).sort();
  return { p999: sorted[Math.min(n - 1, Math.floor(n * 0.999))], max };
}

/** SSIM of 8×8 blocks after a 2×2 box downscale (luma over black / white, the lower mean). */
function ssimHalf(orig: Uint8Array, width: number, height: number, read: Reader): number {
  const hw = width >> 1;
  const hh = height >> 1;
  if (hw < 1 || hh < 1) return 1;
  const px = new Float64Array(4);
  let blocks = 0;
  let sumB = 0;
  let sumW = 0;
  for (let by = 0; by * BLOCK < hh; by++) {
    for (let bx = 0; bx * BLOCK < hw; bx++) {
      let n = 0;
      let visible = false;
      let sob = 0, srb = 0, soob = 0, srrb = 0, sorb = 0;
      let sow = 0, srw = 0, soow = 0, srrw = 0, sorw = 0;
      for (let y = by * BLOCK; y < Math.min(hh, by * BLOCK + BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(hw, bx * BLOCK + BLOCK); x++) {
          let yo = 0, yr = 0, ao = 0, ar = 0;
          for (let k = 0; k < 4; k++) {
            const i = (2 * y + (k >> 1)) * width + 2 * x + (k & 1);
            const p = i * 4;
            read(i, px);
            const a = orig[p + 3];
            yo += ((KR * orig[p] + KG * orig[p + 1] + KB * orig[p + 2]) * a) / 255;
            yr += ((KR * px[0] + KG * px[1] + KB * px[2]) * px[3]) / 255;
            ao += a;
            ar += px[3];
          }
          if (ao !== 0 || ar !== 0) visible = true;
          yo /= 4;
          yr /= 4;
          const yow = yo + 255 - ao / 4;
          const yrw = yr + 255 - ar / 4;
          n++;
          sob += yo;
          srb += yr;
          soob += yo * yo;
          srrb += yr * yr;
          sorb += yo * yr;
          sow += yow;
          srw += yrw;
          soow += yow * yow;
          srrw += yrw * yrw;
          sorw += yow * yrw;
        }
      }
      if (!visible) continue;
      const inv = 1 / n;
      blocks++;
      sumB += ssimBlock(sob * inv, srb * inv, soob * inv, srrb * inv, sorb * inv);
      sumW += ssimBlock(sow * inv, srw * inv, soow * inv, srrw * inv, sorw * inv);
    }
  }
  return blocks > 0 ? Math.min(sumB, sumW) / blocks : 1;
}
