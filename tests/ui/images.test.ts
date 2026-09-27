import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import type { Asset } from '../../src/ir/types';
import {
  ImagesCancelledError,
  chooseEncoding,
  downscaleTarget,
  planAsset,
  processAssets,
  rgbaHasTransparency,
  type ImageCodec,
  type ImageOptions,
  type Surface,
} from '../../src/ui/images';

const asset = (o: Partial<Asset> & Pick<Asset, 'id'>): Asset => ({
  mime: 'image/png',
  role: 'image-fill',
  data: new Uint8Array(1000),
  width: 400,
  height: 300,
  ...o,
});

const OPTS: ImageOptions = { rasterScale: 2, jpeg: true, jpegQuality: 0.8 };
const factor = 2 * CONFIG.raster.maxImageOversample;

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
  it('never touches vector fallbacks, SVGs, GIFs or broken assets', () => {
    expect(planAsset(asset({ id: 'v', role: 'vector-fallback' }), OPTS)).toBeNull();
    expect(planAsset(asset({ id: 's', role: 'svg', mime: 'image/svg+xml' }), OPTS)).toBeNull();
    expect(planAsset(asset({ id: 'g', mime: 'image/gif', width: 4000, height: 3000, displayWidth: 10, displayHeight: 10 }), OPTS)).toBeNull();
    expect(planAsset(asset({ id: 'z', width: 0 }), OPTS)).toBeNull();
    expect(planAsset(asset({ id: 'e', data: new Uint8Array(0) }), OPTS)).toBeNull();
  });

  it('JPEG off and nothing to downscale → untouched', () => {
    expect(planAsset(asset({ id: 'a', role: 'background' }), { ...OPTS, jpeg: false })).toBeNull();
  });

  it('PNG with JPEG on → try JPEG, scan alpha unless hasAlpha === false', () => {
    expect(planAsset(asset({ id: 'a', role: 'raster' }), OPTS)).toEqual({ width: 400, height: 300, downscale: false, tryJpeg: true, scanAlpha: true });
    expect(planAsset(asset({ id: 'a', role: 'background', hasAlpha: false }), OPTS)?.scanAlpha).toBe(false);
    expect(planAsset(asset({ id: 'a', role: 'background', hasAlpha: true }), OPTS)?.scanAlpha).toBe(true);
  });

  it('JPEG originals are re-encoded only when downscaled', () => {
    expect(planAsset(asset({ id: 'a', mime: 'image/jpeg' }), OPTS)).toBeNull();
    const plan = planAsset(asset({ id: 'a', mime: 'image/jpeg', width: 4000, height: 3000, displayWidth: 400, displayHeight: 300 }), OPTS);
    expect(plan).toMatchObject({ downscale: true, tryJpeg: false, scanAlpha: false });
  });
});

describe('chooseEncoding', () => {
  it('JPEG wins only with enough saving', () => {
    const r = CONFIG.raster.jpegMinSavingRatio;
    expect(chooseEncoding(1000, null, Math.floor(1000 * r))).toBe('jpeg');
    expect(chooseEncoding(1000, null, Math.floor(1000 * r) + 5)).toBe('original');
    expect(chooseEncoding(1000, null, null)).toBe('original');
  });

  it('compares JPEG with the resampled PNG, not with the original', () => {
    expect(chooseEncoding(10_000, 2000, 1500, 0.9)).toBe('jpeg');
    expect(chooseEncoding(10_000, 2000, 1900, 0.9)).toBe('resampled');
  });

  it('keeps the original when nothing gets smaller', () => {
    expect(chooseEncoding(1000, 1200, null)).toBe('original');
    expect(chooseEncoding(1000, 1200, 1050, 0.9)).toBe('original');
  });
});

describe('rgbaHasTransparency', () => {
  it('detects any non-opaque pixel', () => {
    expect(rgbaHasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(rgbaHasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
    expect(rgbaHasTransparency(new Uint8ClampedArray([]))).toBe(false);
  });
});

// ─── processAssets with a fake codec ────────────────────────────────────────

interface FakeSurface extends Surface {
  transparent: boolean;
}

/** Sizes: PNG = w·h·png bytes, JPEG = w·h·jpeg·quality bytes. data[0] === 1 marks a transparent image. */
function fakeCodec(png = 1, jpeg = 0.25): ImageCodec<FakeSurface> & { calls: string[]; released: number } {
  const codec = {
    calls: [] as string[],
    released: 0,
    async render(data: Uint8Array, mime: string, width: number, height: number): Promise<FakeSurface> {
      codec.calls.push(`render ${mime} ${width}x${height}`);
      if (data[0] === 2) throw new Error('corrupt image');
      return { width, height, transparent: data[0] === 1 };
    },
    hasTransparency(s: FakeSurface): boolean {
      codec.calls.push('scan');
      return s.transparent;
    },
    async encode(s: FakeSurface, mime: string, quality: number): Promise<Uint8Array> {
      codec.calls.push(`encode ${mime}`);
      const size = Math.round(s.width * s.height * (mime === 'image/jpeg' ? jpeg * quality : png));
      return new Uint8Array(Math.max(1, size));
    },
    release(): void {
      codec.released++;
    },
  };
  return codec;
}

const noYield = () => Promise.resolve();

describe('processAssets', () => {
  it('encodes opaque rasters as JPEG, keeps transparent ones, leaves vectors alone', async () => {
    const opaque = asset({ id: 'bg', role: 'background', data: new Uint8Array(400 * 300), hasAlpha: false });
    const transparentData = new Uint8Array(400 * 300);
    transparentData[0] = 1;
    const transparent = asset({ id: 'r', role: 'raster', data: transparentData });
    const icon = asset({ id: 'icon', role: 'vector-fallback' });
    const assets: Record<string, Asset> = { bg: opaque, r: transparent, icon };
    const codec = fakeCodec();
    const progress: Array<[number, number]> = [];
    const stats = await processAssets(assets, OPTS, { onProgress: (d, t) => progress.push([d, t]), yieldFn: noYield }, codec);

    expect(assets.bg.mime).toBe('image/jpeg');
    expect(assets.bg.hasAlpha).toBe(false);
    expect(assets.bg.data.byteLength).toBe(Math.round(400 * 300 * 0.25 * 0.8));
    expect(assets.r).toEqual({ ...transparent, hasAlpha: true });
    expect(assets.icon).toBe(icon);
    expect(opaque.mime).toBe('image/png'); // the original object is not mutated
    expect(stats).toMatchObject({ examined: 2, downscaled: 0, jpeg: 1 });
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(codec.calls.filter((c) => c === 'scan')).toHaveLength(1); // hasAlpha === false skips the scan
    expect(codec.released).toBe(2);
  });

  it('downscales oversized image fills (PNG kept when JPEG is off)', async () => {
    const big = asset({ id: 'photo', width: 4000, height: 3000, data: new Uint8Array(12_000_000), displayWidth: 400, displayHeight: 300 });
    const assets = { photo: big };
    const stats = await processAssets(assets, { ...OPTS, jpeg: false }, { yieldFn: noYield }, fakeCodec());
    expect(assets.photo.mime).toBe('image/png');
    expect(assets.photo.width).toBe(Math.round(400 * factor));
    expect(assets.photo.height).toBe(Math.round(300 * factor));
    expect(stats.downscaled).toBe(1);
    expect(stats.jpeg).toBe(0);
  });

  it('downscaled JPEG originals stay JPEG', async () => {
    const big = asset({ id: 'photo', mime: 'image/jpeg', width: 4000, height: 3000, data: new Uint8Array(5_000_000), displayWidth: 400, displayHeight: 300 });
    const assets = { photo: big };
    const codec = fakeCodec();
    await processAssets(assets, { ...OPTS, jpeg: false }, { yieldFn: noYield }, codec);
    expect(assets.photo.mime).toBe('image/jpeg');
    expect(assets.photo.width).toBe(Math.round(400 * factor));
    expect(codec.calls).not.toContain('scan');
  });

  it('keeps the PNG when JPEG does not save enough', async () => {
    const a = asset({ id: 'bg', role: 'background', data: new Uint8Array(400 * 300), hasAlpha: false });
    const assets = { bg: a };
    await processAssets(assets, OPTS, { yieldFn: noYield }, fakeCodec(1, 1.2));
    expect(assets.bg).toBe(a);
  });

  it('a failing asset is kept and reported; the others continue', async () => {
    const bad = new Uint8Array(100);
    bad[0] = 2;
    const assets: Record<string, Asset> = {
      bad: asset({ id: 'bad', role: 'raster', data: bad }),
      good: asset({ id: 'good', role: 'background', data: new Uint8Array(400 * 300), hasAlpha: false }),
    };
    const errors: string[] = [];
    await processAssets(assets, OPTS, { yieldFn: noYield, onError: (a) => errors.push(a.id) }, fakeCodec());
    expect(errors).toEqual(['bad']);
    expect(assets.bad.data).toBe(bad);
    expect(assets.good.mime).toBe('image/jpeg');
  });

  it('stops when cancelled', async () => {
    const assets: Record<string, Asset> = {
      a: asset({ id: 'a', role: 'raster' }),
      b: asset({ id: 'b', role: 'raster' }),
    };
    let calls = 0;
    await expect(
      processAssets(assets, OPTS, { yieldFn: noYield, isCancelled: () => calls++ > 0 }, fakeCodec()),
    ).rejects.toBeInstanceOf(ImagesCancelledError);
  });

  it('nothing eligible → no codec needed', async () => {
    const stats = await processAssets({ i: asset({ id: 'i', role: 'vector-fallback' }) }, OPTS);
    expect(stats).toEqual({ examined: 0, downscaled: 0, jpeg: 0, bytesBefore: 0, bytesAfter: 0 });
  });
});
