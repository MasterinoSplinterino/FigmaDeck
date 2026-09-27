import { describe, expect, it, vi } from 'vitest';
import { countColors, hasTransparency, type RgbaPixels } from '../../src/compress';
import { CONFIG } from '../../src/config';
import type { Asset } from '../../src/ir/types';
import { inThreadCompressor, runPixelJob, type PixelCompressor, type PixelJob, type PixelLib, type PixelResult } from '../../src/ui/compress-job';
import {
  ImagesCancelledError,
  downscaleTarget,
  emptyImageStats,
  jpegQualityFor,
  pickEncoding,
  planAsset,
  processAssets,
  selectEncoding,
  type BitmapInput,
  type ImageCodec,
  type ImageOptions,
  type Surface,
} from '../../src/ui/images';
import { decodePngjs, flatIcon, ihdr, smoothGradient } from '../compress/helpers';

const asset = (o: Partial<Asset> & Pick<Asset, 'id'>): Asset => ({
  mime: 'image/png',
  role: 'image-fill',
  data: new Uint8Array(1000),
  width: 400,
  height: 300,
  ...o,
});

const OPTS: ImageOptions = { rasterScale: 2, compression: 'balanced', jpegQuality: 0.8 };
const factor = 2 * CONFIG.raster.maxImageOversample;
const RATIO = CONFIG.raster.jpegMinSavingRatio;
const noYield = () => Promise.resolve();

// ─── Synthetic bitmaps ───────────────────────────────────────────────────────

/** Opaque "photo": smooth colour fields plus deterministic grain (thousands of colours). */
function photo(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  let seed = 7;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const n = ((seed >>> 16) % 21) - 10;
      const i = (y * w + x) * 4;
      out[i] = Math.max(0, Math.min(255, Math.round(120 + 100 * Math.sin(x / 17)) + n));
      out[i + 1] = Math.max(0, Math.min(255, Math.round(110 + 90 * Math.cos(y / 13)) + n));
      out[i + 2] = Math.max(0, Math.min(255, Math.round(((x + y) * 255) / (w + h)) + n));
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Opaque flat graphic: ≤ 256 colours. */
const FLAT_COLORS = [
  [255, 91, 46, 255],
  [17, 17, 17, 255],
  [244, 241, 234, 255],
  [56, 189, 248, 255],
] as const;

/** A fake canvas JPEG: `bytesPerPixel × w × h` bytes (records the quality it was asked for). */
function fakeJpeg(bytesPerPixel: number, w: number, h: number) {
  const calls: number[] = [];
  const encode = vi.fn(async (quality: number) => {
    calls.push(quality);
    return new Uint8Array(Math.max(1, Math.round(bytesPerPixel * w * h)));
  });
  return { encode, calls };
}

function input(rgba: RgbaPixels, w: number, h: number, o: Partial<BitmapInput> = {}): BitmapInput {
  return { rgba, width: w, height: h, role: 'raster', original: { bytes: w * h * 4, mime: 'image/png' }, ...o };
}

/** In-thread compressor that records its jobs (sizes, flags; the pixels are not kept). */
function recordingCompressor(): PixelCompressor & { jobs: Array<Omit<PixelJob, 'rgba'>> } {
  const inner = inThreadCompressor(noYield);
  const jobs: Array<Omit<PixelJob, 'rgba'>> = [];
  return {
    jobs,
    get thread() {
      return inner.thread;
    },
    run(job, signal) {
      const { rgba: _rgba, ...rest } = job;
      jobs.push(rest);
      return inner.run(job, signal);
    },
  };
}

// ─── Planning ────────────────────────────────────────────────────────────────

describe('downscaleTarget', () => {
  it('only image fills with a known display size', () => {
    expect(downscaleTarget(asset({ id: 'a', role: 'raster', width: 4000, height: 3000, displayWidth: 100, displayHeight: 75 }), 2)).toBeNull();
    expect(downscaleTarget(asset({ id: 'a', width: 4000, height: 3000 }), 2)).toBeNull();
    expect(downscaleTarget(asset({ id: 'a', width: 4000, height: 3000, displayWidth: 0, displayHeight: 75 }), 2)).toBeNull();
  });

  it('targets display × scale × oversample, aspect kept', () => {
    const t = downscaleTarget(asset({ id: 'a', width: 4000, height: 3000, displayWidth: 400, displayHeight: 300 }), 2);
    expect(t).toEqual({ width: Math.round(400 * factor), height: Math.round(300 * factor) });
  });

  it('uses the larger ratio when the display aspect differs (no side under-sampled)', () => {
    const t = downscaleTarget(asset({ id: 'a', width: 4000, height: 3000, displayWidth: 400, displayHeight: 600 }), 2)!;
    expect(t.height).toBeGreaterThanOrEqual(600 * factor);
    expect(t.width / t.height).toBeCloseTo(4000 / 3000, 2);
  });

  it('skips images that are small enough or would shrink only marginally', () => {
    expect(downscaleTarget(asset({ id: 'a', width: 1000, height: 750, displayWidth: 400, displayHeight: 300 }), 2)).toBeNull();
    // Target / current = 0.923 > imageDownscaleMaxRatio (0.9): not worth re-encoding.
    const width = Math.floor((400 * factor) / 0.923);
    expect(downscaleTarget(asset({ id: 'a', width, height: 300, displayWidth: 400, displayHeight: 1 }), 2)).toBeNull();
    expect(downscaleTarget(asset({ id: 'a', width: width + 200, height: 300, displayWidth: 400, displayHeight: 1 }), 2)).not.toBeNull();
  });

  it('scale 1 targets less than scale 3', () => {
    const a = asset({ id: 'a', width: 8000, height: 6000, displayWidth: 400, displayHeight: 300 });
    expect(downscaleTarget(a, 1)!.width).toBeLessThan(downscaleTarget(a, 3)!.width);
  });
});

describe('planAsset', () => {
  it('never touches SVGs, GIFs or broken assets', () => {
    expect(planAsset(asset({ id: 's', role: 'svg', mime: 'image/svg+xml' }), OPTS)).toBeNull();
    expect(planAsset(asset({ id: 'g', mime: 'image/gif', width: 4000, height: 3000, displayWidth: 10, displayHeight: 10 }), OPTS)).toBeNull();
    expect(planAsset(asset({ id: 'z', width: 0 }), OPTS)).toBeNull();
    expect(planAsset(asset({ id: 'e', data: new Uint8Array(0) }), OPTS)).toBeNull();
  });

  it('compression on: every PNG role is compressed, vector fallbacks included', () => {
    for (const role of ['image-fill', 'background', 'raster', 'vector-fallback'] as const) {
      expect(planAsset(asset({ id: 'a', role }), OPTS)).toEqual({ width: 400, height: 300, downscale: false, kind: 'compress' });
    }
    const big = planAsset(asset({ id: 'a', width: 4000, height: 3000, displayWidth: 400, displayHeight: 300 }), OPTS);
    expect(big).toEqual({ width: Math.round(400 * factor), height: Math.round(300 * factor), downscale: true, kind: 'compress' });
  });

  it('compression off: untouched unless downscaled (then resampled in the same format)', () => {
    const off: ImageOptions = { ...OPTS, compression: 'off' };
    expect(planAsset(asset({ id: 'a', role: 'background' }), off)).toBeNull();
    expect(planAsset(asset({ id: 'v', role: 'vector-fallback' }), off)).toBeNull();
    expect(planAsset(asset({ id: 'a', width: 4000, height: 3000, displayWidth: 400, displayHeight: 300 }), off)).toMatchObject({ downscale: true, kind: 'resample' });
  });

  it('JPEG originals are re-encoded only when downscaled', () => {
    expect(planAsset(asset({ id: 'a', mime: 'image/jpeg' }), OPTS)).toBeNull();
    const plan = planAsset(asset({ id: 'a', mime: 'image/jpeg', width: 4000, height: 3000, displayWidth: 400, displayHeight: 300 }), OPTS);
    expect(plan).toMatchObject({ downscale: true, kind: 'resample' });
  });
});

describe('jpegQualityFor', () => {
  it('balanced uses the setting, strong caps it', () => {
    expect(jpegQualityFor({ compression: 'balanced', jpegQuality: 0.9 })).toBe(0.9);
    expect(jpegQualityFor({ compression: 'strong', jpegQuality: 0.9 })).toBe(CONFIG.ui.imageStrongJpegQuality);
    expect(jpegQualityFor({ compression: 'strong', jpegQuality: 0.6 })).toBe(0.6);
  });
});

// ─── Pure choice ─────────────────────────────────────────────────────────────

describe('pickEncoding', () => {
  const png = (bytes: number) => ({ bytes, mime: 'image/png' as const });

  it('the smallest PNG candidate wins among PNGs', () => {
    expect(
      pickEncoding(png(1000), [
        { method: 'lossless', bytes: 700 },
        { method: 'palette-lossy', bytes: 300 },
      ]),
    ).toBe('palette-lossy');
    expect(pickEncoding(png(1000), [{ method: 'palette-exact', bytes: 400 }])).toBe('palette-exact');
  });

  it('JPEG wins only when ≤ ratio × the best PNG (or the PNG original)', () => {
    expect(pickEncoding(png(1000), [{ method: 'jpeg', bytes: Math.floor(1000 * RATIO) }])).toBe('jpeg');
    expect(pickEncoding(png(1000), [{ method: 'jpeg', bytes: Math.floor(1000 * RATIO) + 5 }])).toBe('original');
    expect(
      pickEncoding(png(10_000), [
        { method: 'palette-lossy', bytes: 2000 },
        { method: 'jpeg', bytes: 1500 },
      ]),
    ).toBe('jpeg');
    expect(
      pickEncoding(png(10_000), [
        { method: 'palette-lossy', bytes: 2000 },
        { method: 'jpeg', bytes: 1900 },
      ]),
    ).toBe('palette-lossy');
  });

  it('never keeps anything that is not smaller than the original', () => {
    expect(pickEncoding(png(1000), [{ method: 'lossless', bytes: 1000 }])).toBe('original');
    expect(pickEncoding(png(1000), [{ method: 'lossless', bytes: 1200 }, { method: 'jpeg', bytes: 1050 }])).toBe('original');
    expect(pickEncoding(png(1000), [])).toBe('original');
  });

  it('a downscaled JPEG original only has to be smaller', () => {
    expect(pickEncoding({ bytes: 5000, mime: 'image/jpeg' }, [{ method: 'jpeg', bytes: 4900 }])).toBe('jpeg');
    expect(pickEncoding({ bytes: 5000, mime: 'image/jpeg' }, [{ method: 'jpeg', bytes: 5000 }])).toBe('original');
  });
});

// ─── Pixel job ───────────────────────────────────────────────────────────────

describe('runPixelJob', () => {
  it('≤ 256 colours: exact palette only', () => {
    const rgba = flatIcon(60, 40, FLAT_COLORS);
    const r = runPixelJob({ rgba, width: 60, height: 40, level: 'balanced', maxBytes: Infinity, originalBytes: 1e6, hasJpeg: true });
    expect(r.steps).toEqual(['count', 'palette-exact']);
    expect(r.method).toBe('palette-exact');
    expect(ihdr(r.bytes!).colorType).toBe(3);
    expect(Array.from(decodePngjs(r.bytes!).data)).toEqual(Array.from(rgba));
  });

  it('with a JPEG candidate, photos (> flat colour limit) skip the palette search', () => {
    const rgba = photo(80, 60);
    expect(countColors(rgba, CONFIG.ui.imagePaletteMaxColorsWithJpeg)).toBeGreaterThan(CONFIG.ui.imagePaletteMaxColorsWithJpeg);
    const r = runPixelJob({ rgba, width: 80, height: 60, level: 'balanced', maxBytes: 1e9, originalBytes: 1e9, hasJpeg: true });
    expect(r.steps).toEqual(['count', 'skip:jpeg']);
    expect(r.method).toBeNull();
    expect(r.bytes).toBeNull();
  });

  it('lossless re-encode only when the palette is not far below the original', () => {
    const rgba = smoothGradient(160, 120);
    const far = runPixelJob({ rgba, width: 160, height: 120, level: 'balanced', maxBytes: 1e9, originalBytes: 1e9, hasJpeg: false });
    expect(far.steps).toEqual(['count', 'palette-lossy']);
    expect(far.method).toBe('palette-lossy');
    const near = runPixelJob({ rgba, width: 160, height: 120, level: 'balanced', maxBytes: 1e9, originalBytes: far.bytes!.length, hasJpeg: false });
    expect(near.steps).toEqual(['count', 'palette-lossy', 'lossless']);
    expect(near.method).toBe('palette-lossy'); // still the smallest
  });

  it('nothing under maxBytes → no result', () => {
    const rgba = smoothGradient(64, 48);
    const r = runPixelJob({ rgba, width: 64, height: 48, level: 'balanced', maxBytes: 10, originalBytes: 10, hasJpeg: false });
    expect(r.method).toBeNull();
    expect(r.steps).toEqual(['count', 'palette-lossy', 'lossless']);
  });

  it('huge bitmaps skip the palette / lossless attempts', () => {
    const lib: PixelLib = {
      countColors: () => 5000,
      compressRgba: vi.fn(() => null),
      optimizeLossless: vi.fn(() => new Uint8Array(1)),
    };
    const side = Math.ceil(Math.sqrt(CONFIG.ui.imageCompressMaxPixels)) + 1;
    const r = runPixelJob({ rgba: new Uint8Array(4), width: side, height: side, level: 'strong', maxBytes: 1e9, originalBytes: 1e9, hasJpeg: false }, lib);
    expect(r.steps).toEqual(['count', 'skip:size']);
    expect(lib.compressRgba).not.toHaveBeenCalled();
    expect(lib.optimizeLossless).not.toHaveBeenCalled();
  });

  it('passes the level and maxBytes to compressRgba', () => {
    const lib: PixelLib = {
      countColors: () => 300,
      compressRgba: vi.fn(() => null),
      optimizeLossless: vi.fn(() => new Uint8Array(50)),
    };
    const r = runPixelJob({ rgba: new Uint8Array(16), width: 2, height: 2, level: 'strong', maxBytes: 77, originalBytes: 100, hasJpeg: false }, lib);
    expect(lib.compressRgba).toHaveBeenCalledWith(expect.any(Uint8Array), 2, 2, 'strong', { maxBytes: 77 });
    expect(r.method).toBe('lossless');
  });
});

// ─── selectEncoding (synthetic RGBA, real codec in this thread, fake JPEG) ───

describe('selectEncoding', () => {
  it('flat ≤ 256 colours → exact palette (lossless), even when JPEG would be allowed', async () => {
    const rgba = flatIcon(120, 80, FLAT_COLORS);
    const jpeg = fakeJpeg(0.5, 120, 80);
    const s = await selectEncoding(input(rgba, 120, 80, { role: 'background' }), OPTS, { compressor: inThreadCompressor(noYield), encodeJpeg: jpeg.encode });
    expect(s.method).toBe('palette-exact');
    expect(s.mime).toBe('image/png');
    expect(s.transparent).toBe(false);
    expect(jpeg.calls).toEqual([OPTS.jpegQuality]); // tried, lost
    expect(Array.from(decodePngjs(s.bytes!).data)).toEqual(Array.from(rgba));
  });

  it('opaque photo → JPEG when smaller (the palette search is skipped)', async () => {
    const rgba = photo(120, 90);
    const jpeg = fakeJpeg(0.3, 120, 90);
    const compressor = recordingCompressor();
    const s = await selectEncoding(input(rgba, 120, 90, { role: 'image-fill' }), OPTS, { compressor, encodeJpeg: jpeg.encode });
    expect(s.method).toBe('jpeg');
    expect(s.mime).toBe('image/jpeg');
    expect(s.bytes!.byteLength).toBe(Math.round(0.3 * 120 * 90));
    expect(s.job?.steps).toEqual(['count', 'skip:jpeg']);
    // maxBytes = min(original, JPEG / ratio): a PNG must beat the JPEG by the saving ratio.
    expect(compressor.jobs[0].maxBytes).toBeCloseTo(Math.min(120 * 90 * 4, s.bytes!.byteLength / RATIO), 6);
    expect(compressor.jobs[0].hasJpeg).toBe(true);
  });

  it('strong: JPEG quality capped', async () => {
    const jpeg = fakeJpeg(0.3, 40, 30);
    await selectEncoding(input(photo(40, 30), 40, 30, { role: 'background' }), { ...OPTS, compression: 'strong', jpegQuality: 0.95 }, { compressor: inThreadCompressor(noYield), encodeJpeg: jpeg.encode });
    expect(jpeg.calls).toEqual([CONFIG.ui.imageStrongJpegQuality]);
  });

  it('transparent gradient → palette (lossy) or lossless, never JPEG', async () => {
    const rgba = smoothGradient(200, 150);
    expect(hasTransparency(rgba)).toBe(true);
    const jpeg = fakeJpeg(0.01, 200, 150);
    for (const role of ['raster', 'background', 'image-fill'] as const) {
      const s = await selectEncoding(input(rgba.slice(), 200, 150, { role }), OPTS, { compressor: inThreadCompressor(noYield), encodeJpeg: jpeg.encode });
      expect(['palette-lossy', 'lossless']).toContain(s.method);
      expect(s.mime).toBe('image/png');
      expect(s.transparent).toBe(true);
    }
    expect(jpeg.encode).not.toHaveBeenCalled();
  });

  it('vector fallbacks never become JPEG, even when opaque', async () => {
    const jpeg = fakeJpeg(0.001, 100, 80);
    const s = await selectEncoding(input(photo(100, 80), 100, 80, { role: 'vector-fallback' }), OPTS, { compressor: inThreadCompressor(noYield), encodeJpeg: jpeg.encode });
    expect(jpeg.encode).not.toHaveBeenCalled();
    expect(s.method).not.toBe('jpeg');
    expect(s.job?.steps).toContain('palette-lossy');
  });

  it('never bigger than the original', async () => {
    for (const [rgba, role] of [
      [flatIcon(60, 40, FLAT_COLORS), 'raster'],
      [photo(60, 40), 'image-fill'],
      [smoothGradient(60, 40), 'raster'],
    ] as const) {
      const s = await selectEncoding(input(rgba, 60, 40, { role, original: { bytes: 40, mime: 'image/png' } }), OPTS, {
        compressor: inThreadCompressor(noYield),
        encodeJpeg: fakeJpeg(1, 60, 40).encode,
      });
      expect(s.method).toBe('original');
      expect(s.bytes).toBeNull();
    }
  });

  it("'off' keeps the bytes and runs nothing", async () => {
    const jpeg = fakeJpeg(0.01, 60, 40);
    const run = vi.fn();
    const release = vi.fn();
    const s = await selectEncoding(input(photo(60, 40), 60, 40), { ...OPTS, compression: 'off' }, { compressor: { thread: null, run }, encodeJpeg: jpeg.encode, release });
    expect(s).toMatchObject({ method: 'original', bytes: null, mime: 'image/png', job: null });
    expect(run).not.toHaveBeenCalled();
    expect(jpeg.encode).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('image targets: opaque slide pictures go straight to JPEG; a transparent frame gets PNG candidates', async () => {
    const target: ImageOptions = { ...OPTS, imageTarget: true };
    const compressor = recordingCompressor();
    const flat = flatIcon(80, 60, FLAT_COLORS);
    const opaque = await selectEncoding(input(flat, 80, 60, { role: 'background' }), target, { compressor, encodeJpeg: fakeJpeg(0.5, 80, 60).encode });
    expect(opaque.method).toBe('jpeg');
    expect(compressor.jobs).toHaveLength(0);
    const transparent = await selectEncoding(input(smoothGradient(80, 60), 80, 60, { role: 'background' }), target, { compressor, encodeJpeg: fakeJpeg(0.01, 80, 60).encode });
    expect(transparent.method).not.toBe('jpeg');
    expect(compressor.jobs).toHaveLength(1);
  });

  it('releases the bitmap source before the pixel job', async () => {
    const order: string[] = [];
    const compressor: PixelCompressor = {
      thread: 'worker',
      run: async (job) => {
        order.push('job');
        return runPixelJob(job);
      },
    };
    await selectEncoding(input(smoothGradient(40, 30), 40, 30), OPTS, { compressor, encodeJpeg: fakeJpeg(1, 40, 30).encode, release: () => order.push('release') });
    expect(order).toEqual(['release', 'job']);
  });
});

// ─── processAssets with a fake codec ────────────────────────────────────────

interface FakeSurface extends Surface {
  rgba: Uint8Array;
}

/**
 * "Decodes" an asset to the synthetic RGBA registered for its first byte (resampled to the requested
 * size by nearest neighbour). PNG re-encodes cost w·h·png bytes, JPEG w·h·jpeg·quality bytes.
 */
function fakeCodec(bitmaps: Record<number, { rgba: Uint8Array; width: number; height: number }>, png = 1, jpeg = 0.25) {
  const codec = {
    calls: [] as string[],
    released: 0,
    async render(data: Uint8Array, mime: string, width: number, height: number): Promise<FakeSurface> {
      codec.calls.push(`render ${mime} ${width}x${height}`);
      const src = bitmaps[data[0]];
      if (!src) throw new Error('corrupt image');
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
          const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
          rgba.set(src.rgba.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * width + x) * 4);
        }
      }
      return { width, height, rgba };
    },
    pixels(s: FakeSurface): Uint8Array {
      codec.calls.push('pixels');
      return s.rgba.slice();
    },
    async encode(s: FakeSurface, mime: string, quality: number): Promise<Uint8Array> {
      codec.calls.push(`encode ${mime} ${quality}`);
      const size = Math.round(s.width * s.height * (mime === 'image/jpeg' ? jpeg * quality : png));
      return new Uint8Array(Math.max(1, size));
    },
    release(): void {
      codec.released++;
    },
  } satisfies ImageCodec<FakeSurface> & { calls: string[]; released: number };
  return codec;
}

/** Asset whose data[0] selects a registered bitmap. */
function bitmapAsset(id: string, key: number, bytes: number, o: Partial<Asset> = {}): Asset {
  const data = new Uint8Array(bytes);
  data[0] = key;
  return asset({ id, data, ...o });
}

describe('processAssets', () => {
  const FLAT = { rgba: flatIcon(64, 48, FLAT_COLORS), width: 64, height: 48 };
  const PHOTO = { rgba: photo(64, 48), width: 64, height: 48 };
  const GRADIENT = { rgba: smoothGradient(64, 48), width: 64, height: 48 };

  it('compresses every eligible asset, records per-asset stats and progress', async () => {
    const assets: Record<string, Asset> = {
      photo: bitmapAsset('photo', 2, 64 * 48 * 3, { role: 'image-fill', width: 64, height: 48 }),
      icon: bitmapAsset('icon', 1, 64 * 48 * 3, { role: 'vector-fallback', width: 64, height: 48 }),
      glow: bitmapAsset('glow', 3, 64 * 48 * 3, { role: 'raster', width: 64, height: 48 }),
      svg: asset({ id: 'svg', role: 'svg', mime: 'image/svg+xml' }),
    };
    const svg = assets.svg;
    const codec = fakeCodec({ 1: FLAT, 2: PHOTO, 3: GRADIENT });
    const progress: unknown[] = [];
    const stats = await processAssets(assets, OPTS, { onProgress: (d, t, c) => progress.push([d, t, c]), yieldFn: noYield }, codec);

    expect(assets.photo.mime).toBe('image/jpeg');
    expect(assets.photo.hasAlpha).toBe(false);
    expect(assets.icon.mime).toBe('image/png');
    expect(ihdr(assets.icon.data).colorType).toBe(3);
    expect(assets.glow.mime).toBe('image/png');
    expect(assets.glow.hasAlpha).toBe(true);
    expect(assets.svg).toBe(svg);
    expect(stats.examined).toBe(3);
    expect(stats.methods.jpeg).toBe(1);
    expect(stats.methods['palette-exact']).toBe(1);
    expect(stats.methods['palette-lossy'] + stats.methods.lossless).toBe(1);
    expect(stats.items.map((i) => i.id)).toEqual(['photo', 'icon', 'glow']);
    expect(stats.bytesBefore).toBe(3 * 64 * 48 * 3);
    expect(stats.bytesAfter).toBe(stats.items.reduce((n, i) => n + i.bytesAfter, 0));
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(stats.thread).toBe('main'); // default compressor: this thread
    expect(stats.compression).toBe('balanced');
    expect(progress).toEqual([
      [0, 3, { width: 64, height: 48, thread: null }],
      [1, 3, { width: 64, height: 48, thread: 'main' }],
      [2, 3, { width: 64, height: 48, thread: 'main' }],
      [3, 3, undefined],
    ]);
    expect(codec.released).toBe(3);
    // JPEG only for the opaque image fill.
    expect(codec.calls.filter((c) => c.startsWith('encode image/jpeg'))).toEqual(['encode image/jpeg 0.8']);
  });

  it("'off' keeps the bytes; a downscaled PNG is re-encoded losslessly, a JPEG stays JPEG", async () => {
    const keep = bitmapAsset('keep', 3, 5000, { role: 'raster', width: 64, height: 48 });
    const big = bitmapAsset('big', 2, 12_000_000, { width: 4000, height: 3000, displayWidth: 400, displayHeight: 300 });
    const bigJpeg = bitmapAsset('bigJpeg', 2, 5_000_000, { mime: 'image/jpeg', width: 4000, height: 3000, displayWidth: 400, displayHeight: 300 });
    const assets: Record<string, Asset> = { keep, big, bigJpeg };
    const codec = fakeCodec({ 2: PHOTO, 3: GRADIENT });
    const stats = await processAssets(assets, { ...OPTS, compression: 'off' }, { yieldFn: noYield }, codec);
    expect(assets.keep).toBe(keep);
    expect(assets.big.mime).toBe('image/png');
    expect([assets.big.width, assets.big.height]).toEqual([Math.round(400 * factor), Math.round(300 * factor)]);
    expect(assets.bigJpeg.mime).toBe('image/jpeg');
    expect(codec.calls).toContain(`encode image/jpeg ${CONFIG.ui.imageReencodeJpegQuality}`);
    expect(codec.calls).not.toContain('pixels');
    expect(stats).toMatchObject({ compression: 'off', examined: 2, downscaled: 2, thread: null });
    expect(stats.methods).toMatchObject({ lossless: 1, jpeg: 1 });
  });

  it('a failing asset is kept and reported; the others continue', async () => {
    const bad = new Uint8Array(100);
    bad[0] = 9;
    const assets: Record<string, Asset> = {
      bad: asset({ id: 'bad', role: 'raster', data: bad }),
      good: bitmapAsset('good', 1, 64 * 48 * 4, { role: 'background', width: 64, height: 48 }),
    };
    const errors: string[] = [];
    const stats = await processAssets(assets, OPTS, { yieldFn: noYield, onError: (a) => errors.push(a.id) }, fakeCodec({ 1: FLAT }));
    expect(errors).toEqual(['bad']);
    expect(assets.bad.data).toBe(bad);
    expect(assets.good.mime).toBe('image/png');
    expect(stats.failed).toBe(1);
    expect(stats.items[0]).toMatchObject({ id: 'bad', method: 'original', failed: true });
  });

  it('stops before the next asset when cancelled', async () => {
    const assets: Record<string, Asset> = {
      a: bitmapAsset('a', 1, 20_000, { role: 'raster', width: 64, height: 48 }),
      b: bitmapAsset('b', 1, 20_000, { role: 'raster', width: 64, height: 48 }),
    };
    let calls = 0;
    await expect(processAssets(assets, OPTS, { yieldFn: noYield, isCancelled: () => calls++ > 0 }, fakeCodec({ 1: FLAT }))).rejects.toBeInstanceOf(ImagesCancelledError);
  });

  it('an abort during a pixel job cancels it (not reported as a failed asset)', async () => {
    const assets: Record<string, Asset> = { a: bitmapAsset('a', 3, 20_000, { role: 'raster', width: 64, height: 48 }) };
    const controller = new AbortController();
    const compressor: PixelCompressor = {
      thread: 'worker',
      run: (_job, signal) =>
        new Promise<PixelResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'CompressCancelledError' })));
          controller.abort();
        }),
    };
    const onError = vi.fn();
    await expect(processAssets(assets, OPTS, { yieldFn: noYield, signal: controller.signal, onError }, fakeCodec({ 3: GRADIENT }), compressor)).rejects.toBeInstanceOf(ImagesCancelledError);
    expect(onError).not.toHaveBeenCalled();
  });

  it('nothing eligible → no codec needed', async () => {
    const stats = await processAssets({ i: asset({ id: 'i', role: 'svg', mime: 'image/svg+xml' }) }, OPTS);
    expect(stats).toEqual(emptyImageStats('balanced'));
  });
});
