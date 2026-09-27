import { describe, expect, it } from 'vitest';
import { remapDither, remapNearest } from '../../src/compress/dither';
import { buildHistogram } from '../../src/compress/histogram';
import { measureQuality } from '../../src/compress/metrics';
import { NearestSearch } from '../../src/compress/nearest';
import { exactPalette, paletteCoords, quantize, type QuantizeOptions } from '../../src/compress/quantize';
import { DIM, makeColorSpace } from '../../src/compress/space';
import { smoothGradient } from './helpers';

const space = makeColorSpace();
const QOPTS: QuantizeOptions = { colors: 256, kmeansIterations: 8, kmeansMinImprovement: 0.002, snapMinShare: 0.3, snapMaxDistance: 3 };

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('NearestSearch', () => {
  it('is exact whatever the guess', () => {
    const r = rng(1);
    for (const size of [1, 2, 7, 64, 256]) {
      const coords = Float64Array.from({ length: size * DIM }, () => r() * 300 - 150);
      const nn = new NearestSearch(coords, size);
      for (let q = 0; q < 400; q++) {
        const x = [r() * 320 - 160, r() * 320 - 160, r() * 320 - 160, r() * 320 - 160];
        const best = nn.nearestBrute(x[0], x[1], x[2], x[3]);
        const got = nn.nearest(x[0], x[1], x[2], x[3], Math.floor(r() * size));
        const d = (j: number) => x.reduce((s, v, k) => s + (v - coords[j * DIM + k]) ** 2, 0);
        expect(d(got)).toBeCloseTo(d(best), 9);
      }
    }
  });
});

describe('histogram', () => {
  it('re-bins beyond maxEntries without losing weight', () => {
    const w = 256;
    const h = 256;
    const rgba = smoothGradient(w, h);
    let visible = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) visible++;
    const exact = buildHistogram(rgba, w, h, space, { maxEntries: 1 << 20 });
    const binned = buildHistogram(rgba, w, h, space, { maxEntries: 256 });
    expect(exact.shift).toBe(0);
    expect(exact.colors).not.toBeNull();
    expect(binned.shift).toBeGreaterThan(0);
    expect(binned.colors).toBeNull();
    expect(binned.size).toBeLessThanOrEqual(256);
    expect(exact.totalWeight).toBe(visible);
    expect(binned.totalWeight).toBe(visible);
    expect(exact.hasTransparent).toBe(true);
  });
});

describe('quantize', () => {
  it('keeps exact colours when there are few, with one transparent entry', () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0, 10, 20, 30, 255, 200, 100, 50, 128, 1, 2, 3, 0]);
    const hist = buildHistogram(rgba, 5, 1, space, { maxEntries: 1024 });
    const pal = quantize(hist, space, QOPTS);
    expect(pal.size).toBe(3);
    expect(pal.transparentIndex).toBeGreaterThanOrEqual(0);
    expect(Array.from(pal.rgba.subarray(pal.transparentIndex * 4, pal.transparentIndex * 4 + 4))).toEqual([0, 0, 0, 0]);
  });

  it('never exceeds the requested size, alpha-0 pixels map to the transparent entry', () => {
    const w = 200;
    const h = 150;
    const rgba = smoothGradient(w, h);
    const hist = buildHistogram(rgba, w, h, space, { maxEntries: 65536 });
    for (const colors of [256, 64, 16, 2]) {
      const pal = quantize(hist, space, { ...QOPTS, colors });
      expect(pal.size).toBeLessThanOrEqual(colors);
      const coords = paletteCoords(space, pal);
      const { indices } = remapNearest(rgba, w, h, space, pal, coords);
      for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] === 0) expect(indices[i]).toBe(pal.transparentIndex);
    }
  });

  it('snaps a dominant flat colour to its exact value', () => {
    // 90 % one flat colour + a faint gradient around it: the flat colour must be in the palette.
    const w = 100;
    const h = 100;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set(i < 9000 ? [37, 99, 180, 255] : [37 + (i % 40), 99, 180 - (i % 30), 255], i * 4);
    const hist = buildHistogram(rgba, w, h, space, { maxEntries: 65536 });
    const pal = quantize(hist, space, { ...QOPTS, colors: 8 });
    const entries = Array.from({ length: pal.size }, (_, i) => Array.from(pal.rgba.subarray(i * 4, i * 4 + 4)).join(','));
    expect(entries).toContain('37,99,180,255');
  });

  it('exactPalette returns null above the limit', () => {
    const rgba = smoothGradient(64, 64);
    expect(exactPalette(rgba, 256)).toBeNull();
    const few = new Uint8Array([1, 2, 3, 255, 1, 2, 3, 255, 9, 9, 9, 0, 7, 7, 7, 0]);
    const ex = exactPalette(few, 256)!;
    expect(ex.palette.size).toBe(2); // both alpha-0 pixels share one entry
    expect(Array.from(ex.indices)).toEqual([0, 0, 1, 1]);
  });
});

describe('dithering and metrics', () => {
  it('identical images: PSNR ∞, SSIM 1, no banding', () => {
    const rgba = smoothGradient(64, 48);
    const m = measureQuality(rgba, 64, 48, rgba.slice());
    expect(m.psnr).toBe(Infinity);
    expect(m.ssim).toBeCloseTo(1, 12);
    expect(m.ssimHalf).toBeCloseTo(1, 12);
    expect(m.banding).toBe(0);
    expect(m.maxBlockError).toBe(0);
  });

  it('dithering keeps block means (low banding) where a plain remap bands', () => {
    // A slow opaque ramp with only 8 colours: nearest-colour remap posterizes into wide bands.
    const w = 256;
    const h = 64;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([Math.round(60 + x / 4), Math.round(90 + x / 8), 140, 255], (y * w + x) * 4);
    const hist = buildHistogram(rgba, w, h, space, { maxEntries: 65536 });
    const pal = quantize(hist, space, { ...QOPTS, colors: 8 });
    const coords = paletteCoords(space, pal);
    const plain = remapNearest(rgba, w, h, space, pal, coords);
    const dithered = remapDither(rgba, w, h, space, pal, coords, { strength: 1, map: null, guess: plain.indices, minError2: 2, maxError2: 1e9, overflow: 16 });
    const mPlain = measureQuality(rgba, w, h, { indices: plain.indices, palette: pal.rgba });
    const mDither = measureQuality(rgba, w, h, { indices: dithered, palette: pal.rgba });
    expect(mPlain.banding).toBeGreaterThan(2);
    expect(mDither.banding).toBeLessThan(mPlain.banding / 2);
    expect(mDither.ssimHalf).toBeGreaterThan(mPlain.ssimHalf);
  });
});
