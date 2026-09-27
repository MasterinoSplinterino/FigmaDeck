import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { compressRgba, countColors, hasTransparency, optimizeLossless } from '../../src/compress';
import { CONFIG } from '../../src/config';
import { decodePngjs, decodeUpng, distinctColors, flatIcon, ihdr, smoothGradient } from './helpers';

/** Input with alpha-0 pixels normalised to transparent black (what every path writes). */
function normalised(rgba: Uint8Array): Uint8Array {
  const out = rgba.slice();
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
}

/** Antialiased discs on a transparent background: a flat graphic with a few hundred edge colours. */
function discs(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const shapes = [
    { x: w * 0.25, y: h * 0.4, r: h * 0.25, c: [230, 60, 60] },
    { x: w * 0.45, y: h * 0.55, r: h * 0.3, c: [40, 120, 220] },
    { x: w * 0.7, y: h * 0.35, r: h * 0.28, c: [250, 200, 40] },
    { x: w * 0.8, y: h * 0.7, r: h * 0.2, c: [30, 160, 90] },
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const s of shapes) {
        // 8×8 supersampled coverage
        let cov = 0;
        for (let k = 0; k < 64; k++) if (Math.hypot(x + ((k & 7) + 0.5) / 8 - s.x, y + ((k >> 3) + 0.5) / 8 - s.y) < s.r) cov++;
        const sa = cov / 64;
        r = s.c[0] * sa + r * (1 - sa);
        g = s.c[1] * sa + g * (1 - sa);
        b = s.c[2] * sa + b * (1 - sa);
        a = sa + a * (1 - sa);
      }
      const p = (y * w + x) * 4;
      const A = Math.round(a * 255);
      if (A === 0) continue;
      out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), A], p);
    }
  }
  return out;
}

describe('helpers', () => {
  it('hasTransparency / countColors', () => {
    expect(hasTransparency(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparency(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
    const rgba = new Uint8Array([1, 2, 3, 255, 9, 9, 9, 0, 1, 2, 3, 255, 8, 8, 8, 0, 5, 5, 5, 5]);
    expect(countColors(rgba, 256)).toBe(3); // alpha-0 pixels count once
    expect(countColors(smoothGradient(64, 64), 100)).toBe(101); // stops at limit + 1
  });
});

describe('lossless paths', () => {
  it('≤ 256 colours: exact palette PNG, pixel-identical', () => {
    const colors = [
      [255, 0, 0, 255],
      [0, 128, 255, 255],
      [10, 10, 10, 90],
      [7, 7, 7, 0],
      [250, 250, 250, 255],
    ] as const;
    const rgba = flatIcon(37, 23, colors);
    const res = compressRgba(rgba, 37, 23, 'balanced')!;
    expect(res.lossless).toBe(true);
    expect(res.psnr).toBe(Infinity);
    expect(res.colors).toBe(5);
    expect(res.bitDepth).toBe(4);
    expect(ihdr(res.bytes).colorType).toBe(3);
    expect(Array.from(decodePngjs(res.bytes).data)).toEqual(Array.from(normalised(rgba)));
    expect(Array.from(optimizeLossless(rgba, 37, 23))).toEqual(Array.from(res.bytes));
  });

  it('a fully transparent image is one transparent entry at 1 bit', () => {
    const res = compressRgba(new Uint8Array(40 * 30 * 4), 40, 30, 'strong')!;
    expect(res.lossless).toBe(true);
    expect(res.bitDepth).toBe(1);
    expect(decodePngjs(res.bytes).data.every((v) => v === 0)).toBe(true);
  });

  it('> 256 colours: optimizeLossless re-encodes truecolour exactly', () => {
    const rgba = smoothGradient(150, 100);
    const bytes = optimizeLossless(rgba, 150, 100);
    expect(ihdr(bytes).colorType).toBe(6);
    expect(Array.from(decodeUpng(bytes).data)).toEqual(Array.from(normalised(rgba)));
    const opaque = new Uint8Array(150 * 100 * 4);
    for (let i = 0; i < 150 * 100; i++) opaque.set([(i * 3) & 255, (i >> 4) & 255, (i * 7) & 255, 255], i * 4);
    expect(countColors(opaque, 256)).toBeGreaterThan(256);
    const b2 = optimizeLossless(opaque, 150, 100);
    expect(ihdr(b2).colorType).toBe(2);
    expect(Array.from(decodePngjs(b2).data)).toEqual(Array.from(opaque));
  });
});

describe('compressRgba (lossy palette)', () => {
  const W = 320;
  const H = 240;
  const gradient = smoothGradient(W, H);

  it('round-trips: same size, alpha-0 kept exactly, ≤ N colours, close alpha', () => {
    for (const maxColors of [256, 64, 16]) {
      const res = compressRgba(gradient, W, H, 'strong', { maxColors, thresholds: { minPsnr: 0, minSsim: 0, maxBanding: Infinity } })!;
      expect(res).not.toBeNull();
      expect(res.lossless).toBe(false);
      expect(res.colors).toBeLessThanOrEqual(maxColors);
      for (const dec of [decodePngjs(res.bytes), decodeUpng(res.bytes)]) {
        expect([dec.width, dec.height]).toEqual([W, H]);
        expect(distinctColors(dec.data)).toBeLessThanOrEqual(maxColors);
        for (let i = 3; i < gradient.length; i += 4) {
          if (gradient[i] === 0) expect(dec.data[i]).toBe(0);
          else if (maxColors === 256) expect(Math.abs(dec.data[i] - gradient[i])).toBeLessThanOrEqual(24);
        }
      }
    }
  });

  it('the gate rejects a smooth gradient at an impossible threshold and accepts at a loose one', () => {
    expect(compressRgba(gradient, W, H, 'balanced', { thresholds: { minPsnr: 99 } })).toBeNull();
    expect(compressRgba(gradient, W, H, 'balanced', { thresholds: { maxBanding: 0 } })).toBeNull();
    expect(compressRgba(gradient, W, H, 'balanced', { thresholds: { minSsim: 1.01 } })).toBeNull();
    const loose = compressRgba(gradient, W, H, 'balanced', { thresholds: { minPsnr: 20, minSsim: 0, maxBanding: 100 } });
    expect(loose).not.toBeNull();
    expect(loose!.psnr).toBeGreaterThan(20);
  });

  it('default balanced: a smooth semi-transparent gradient compresses without banding', () => {
    const res = compressRgba(gradient, W, H, 'balanced')!;
    expect(res).not.toBeNull();
    const m = res.metrics!;
    expect(m.banding).toBeLessThanOrEqual(CONFIG.compress.levels.balanced.maxBanding);
    expect(m.psnr).toBeGreaterThanOrEqual(CONFIG.compress.levels.balanced.minPsnr);
    expect(res.bytes.length).toBeLessThan(optimizeLossless(gradient, W, H).length);
    // Undithered, the same palette size bands measurably more.
    const plain = compressRgba(gradient, W, H, 'balanced', { dither: 0, thresholds: { minPsnr: 0, minSsim: 0, maxBanding: Infinity } })!;
    expect(plain.metrics!.banding).toBeGreaterThan(m.banding);
  });

  it('is deterministic', () => {
    const a = compressRgba(gradient, W, H, 'balanced')!;
    const b = compressRgba(gradient.slice(), W, H, 'balanced')!;
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it('flat graphics with antialiasing try smaller palettes', () => {
    const img = discs(400, 250);
    expect(countColors(img, 256)).toBeGreaterThan(256);
    expect(countColors(img, CONFIG.compress.flatMaxColors)).toBeLessThanOrEqual(CONFIG.compress.flatMaxColors);
    const res = compressRgba(img, 400, 250, 'balanced')!;
    expect(res).not.toBeNull();
    expect(res.attempts.length).toBeGreaterThan(1);
    expect(res.colors).toBeLessThanOrEqual(256);
  });

  it('accepts canvas Uint8ClampedArray pixels without copying or modifying them', () => {
    const clamped = new Uint8ClampedArray(gradient.buffer.slice(0));
    const before = Array.from(clamped);
    const a = compressRgba(clamped, W, H, 'balanced')!;
    expect(Array.from(a.bytes)).toEqual(Array.from(compressRgba(gradient, W, H, 'balanced')!.bytes));
    expect(Array.from(clamped)).toEqual(before);
    expect(hasTransparency(clamped)).toBe(true);
    expect(countColors(clamped, 10)).toBe(11);
  });

  it('maxBytes: null unless smaller', () => {
    expect(compressRgba(gradient, W, H, 'balanced', { maxBytes: 100 })).toBeNull();
  });

  it('big-image path: palette from a sample, full remap', () => {
    const cfg = CONFIG.compress as { maxPixels: number; samplePixels: number };
    const saved = [cfg.maxPixels, cfg.samplePixels];
    cfg.maxPixels = 10000;
    cfg.samplePixels = 5000;
    try {
      const res = compressRgba(gradient, W, H, 'strong', { thresholds: { minPsnr: 0, minSsim: 0, maxBanding: Infinity } })!;
      const dec = decodePngjs(res.bytes).data;
      for (let i = 3; i < gradient.length; i += 4) if (gradient[i] === 0) expect(dec[i]).toBe(0);
      expect(res.metrics!.psnr).toBeGreaterThan(35);
    } finally {
      [cfg.maxPixels, cfg.samplePixels] = saved;
    }
  });

  it('rejects bad input', () => {
    expect(() => compressRgba(new Uint8Array(10), 2, 2, 'balanced')).toThrow(RangeError);
    expect(() => compressRgba(new Uint8Array(16), 0, 4, 'balanced')).toThrow(RangeError);
  });

  it('performance smoke: 1 MP in < 5 s', () => {
    const img = smoothGradient(1024, 1024);
    const t = performance.now();
    const res = compressRgba(img, 1024, 1024, 'balanced');
    const ms = performance.now() - t;
    expect(res).not.toBeNull();
    expect(ms).toBeLessThan(5000);
  });
});
