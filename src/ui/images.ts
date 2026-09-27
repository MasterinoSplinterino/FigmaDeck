/**
 * UI-side image optimization before the PPTX / PDF is built (browser only at runtime; the planning
 * helpers are pure and the codec is injectable, so the module is testable in Node).
 *
 * For assets with role `image-fill`, `background` or `raster` (PNG / JPEG only):
 * - image fills larger than displayWidth/Height × rasterScale × CONFIG.raster.maxImageOversample are
 *   downscaled (aspect kept);
 * - with `jpeg` on, opaque bitmaps (alpha scanned unless `hasAlpha === false`) are encoded as JPEG,
 *   kept only when ≤ CONFIG.raster.jpegMinSavingRatio × the PNG size.
 * Vector fallbacks, SVGs and GIFs are never touched. Crops are fractions, so they stay valid.
 */
import { CONFIG } from '../config';
import type { Asset, AssetMime, AssetRole } from '../ir/types';
import type { ImageStats } from './report';

export interface ImageOptions {
  rasterScale: 1 | 2 | 3;
  jpeg: boolean;
  /** 0..1 */
  jpegQuality: number;
}

export interface AssetPlan {
  /** Target bitmap size (px); the current size when not downscaling. */
  width: number;
  height: number;
  downscale: boolean;
  /** Try a JPEG candidate (dropped when the bitmap turns out to be transparent). */
  tryJpeg: boolean;
  /** Scan the pixels for transparency before trying JPEG. */
  scanAlpha: boolean;
}

const PROCESSABLE_ROLES: ReadonlySet<AssetRole> = new Set<AssetRole>(['image-fill', 'background', 'raster']);

type RasterMime = 'image/png' | 'image/jpeg';

function isRasterMime(mime: AssetMime): mime is RasterMime {
  return mime === 'image/png' || mime === 'image/jpeg';
}

/**
 * Downscaled size for an oversized image fill, or null when it is small enough. Both sides keep at
 * least display × scale × oversample px (the larger of the two ratios wins), aspect is preserved,
 * and marginal reductions (> CONFIG.ui.imageDownscaleMaxRatio) are skipped.
 */
export function downscaleTarget(asset: Asset, rasterScale: number): { width: number; height: number } | null {
  if (asset.role !== 'image-fill') return null;
  const dw = asset.displayWidth ?? 0;
  const dh = asset.displayHeight ?? 0;
  if (!(dw > 0 && dh > 0 && asset.width > 0 && asset.height > 0)) return null;
  const factor = rasterScale * CONFIG.raster.maxImageOversample;
  const ratio = Math.max((dw * factor) / asset.width, (dh * factor) / asset.height);
  if (!(ratio <= CONFIG.ui.imageDownscaleMaxRatio)) return null;
  return {
    width: Math.max(1, Math.round(asset.width * ratio)),
    height: Math.max(1, Math.round(asset.height * ratio)),
  };
}

/** What to do with one asset, or null to leave it untouched. */
export function planAsset(asset: Asset, options: ImageOptions): AssetPlan | null {
  if (!PROCESSABLE_ROLES.has(asset.role) || !isRasterMime(asset.mime)) return null;
  if (!(asset.width > 0 && asset.height > 0) || asset.data.byteLength === 0) return null;
  const target = downscaleTarget(asset, options.rasterScale);
  const isJpeg = asset.mime === 'image/jpeg';
  // JPEG → JPEG only pays off together with a downscale (otherwise just generation loss).
  const tryJpeg = options.jpeg && !isJpeg;
  if (!target && !tryJpeg) return null;
  return {
    width: target?.width ?? asset.width,
    height: target?.height ?? asset.height,
    downscale: target !== null,
    tryJpeg,
    scanAlpha: tryJpeg && asset.hasAlpha !== false,
  };
}

/** True when any pixel of an RGBA buffer is not fully opaque. */
export function rgbaHasTransparency(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

export type EncodingChoice = 'original' | 'resampled' | 'jpeg';

/**
 * Pick the encoding to keep:
 * - reference = the resampled bitmap in the original format when downscaled, else the original bytes;
 * - JPEG wins only when ≤ jpegMinSavingRatio × reference;
 * - a result that is not smaller than the original bytes is discarded (keep the original).
 */
export function chooseEncoding(originalBytes: number, resampledBytes: number | null, jpegBytes: number | null, ratio: number = CONFIG.raster.jpegMinSavingRatio): EncodingChoice {
  let choice: EncodingChoice = resampledBytes !== null ? 'resampled' : 'original';
  let size = resampledBytes ?? originalBytes;
  if (jpegBytes !== null && jpegBytes <= ratio * size) {
    choice = 'jpeg';
    size = jpegBytes;
  }
  if (choice !== 'original' && size >= originalBytes) return 'original';
  return choice;
}

// ─── Codec ───────────────────────────────────────────────────────────────────

export interface Surface {
  readonly width: number;
  readonly height: number;
}

/** Decoding / drawing / encoding backend (canvas in the browser, a fake in tests). */
export interface ImageCodec<S extends Surface = Surface> {
  /** Decode `data` and draw it at `width × height` px. */
  render(data: Uint8Array, mime: RasterMime, width: number, height: number): Promise<S>;
  hasTransparency(surface: S): boolean;
  encode(surface: S, mime: RasterMime, quality: number): Promise<Uint8Array>;
  release(surface: S): void;
}

export interface AssetResult {
  asset: Asset;
  choice: EncodingChoice;
}

/** Process one asset according to its plan. Returns the (possibly new) asset object. */
export async function processAsset<S extends Surface>(asset: Asset, plan: AssetPlan, options: ImageOptions, codec: ImageCodec<S>): Promise<AssetResult> {
  const mime = asset.mime as RasterMime;
  const surface = await codec.render(asset.data, mime, plan.width, plan.height);
  try {
    let opaque: boolean | null = mime === 'image/jpeg' || asset.hasAlpha === false ? true : null;
    if (plan.tryJpeg && opaque === null && plan.scanAlpha) opaque = !codec.hasTransparency(surface);

    let resampled: Uint8Array | null = null;
    if (plan.downscale) {
      const q = mime === 'image/jpeg' ? (options.jpeg ? options.jpegQuality : CONFIG.ui.imageReencodeJpegQuality) : 1;
      resampled = await codec.encode(surface, mime, q);
    }
    let jpeg: Uint8Array | null = null;
    if (plan.tryJpeg && opaque === true) jpeg = await codec.encode(surface, 'image/jpeg', options.jpegQuality);

    const choice = chooseEncoding(asset.data.byteLength, resampled?.byteLength ?? null, jpeg?.byteLength ?? null);
    const hasAlpha = opaque === null ? asset.hasAlpha : !opaque;
    if (choice === 'original') return { asset: hasAlpha === asset.hasAlpha ? asset : { ...asset, hasAlpha }, choice };
    const data = choice === 'jpeg' ? jpeg! : resampled!;
    return {
      asset: {
        ...asset,
        data,
        mime: choice === 'jpeg' ? 'image/jpeg' : mime,
        width: surface.width,
        height: surface.height,
        hasAlpha: choice === 'jpeg' ? false : hasAlpha,
      },
      choice,
    };
  } finally {
    codec.release(surface);
  }
}

export interface ProcessHooks {
  onProgress?: (done: number, total: number) => void;
  /** Checked before each asset; when true, processing stops with `ImagesCancelledError`. */
  isCancelled?: () => boolean;
  /** Called between assets (default: a macrotask yield so the UI can repaint). */
  yieldFn?: () => Promise<void>;
  /** A single asset failed (it is kept as it was). */
  onError?: (asset: Asset, error: unknown) => void;
}

export class ImagesCancelledError extends Error {
  constructor() {
    super('Image processing cancelled');
    this.name = 'ImagesCancelledError';
  }
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Optimize every eligible asset in place (`assets[id]` is replaced by a new object), sequentially,
 * with progress and a yield between assets. A failing asset is left unchanged.
 */
export async function processAssets<S extends Surface>(
  assets: Record<string, Asset>,
  options: ImageOptions,
  hooks: ProcessHooks = {},
  codec?: ImageCodec<S>,
): Promise<ImageStats> {
  const jobs: Array<{ id: string; plan: AssetPlan }> = [];
  for (const [id, asset] of Object.entries(assets)) {
    const plan = planAsset(asset, options);
    if (plan) jobs.push({ id, plan });
  }
  const stats: ImageStats = { examined: jobs.length, downscaled: 0, jpeg: 0, bytesBefore: 0, bytesAfter: 0 };
  if (jobs.length === 0) return stats;
  const backend = (codec ?? (createCanvasCodec() as unknown as ImageCodec<S>)) as ImageCodec<S>;
  const pause = hooks.yieldFn ?? macrotask;
  hooks.onProgress?.(0, jobs.length);
  for (let i = 0; i < jobs.length; i++) {
    if (hooks.isCancelled?.()) throw new ImagesCancelledError();
    const { id, plan } = jobs[i];
    const before = assets[id];
    stats.bytesBefore += before.data.byteLength;
    try {
      const { asset, choice } = await processAsset(before, plan, options, backend);
      assets[id] = asset;
      if (choice !== 'original' && plan.downscale) stats.downscaled++;
      if (choice === 'jpeg') stats.jpeg++;
    } catch (e) {
      hooks.onError?.(before, e);
    }
    stats.bytesAfter += assets[id].data.byteLength;
    hooks.onProgress?.(i + 1, jobs.length);
    await pause();
  }
  return stats;
}

// ─── Canvas codec (browser) ──────────────────────────────────────────────────

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Any2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface CanvasSurface extends Surface {
  canvas: AnyCanvas;
  ctx: Any2D;
}

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function context2d(canvas: AnyCanvas): Any2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: false }) as Any2D | null;
  if (!ctx) throw new Error('Canvas 2D context is not available');
  return ctx;
}

async function decode(data: Uint8Array, mime: RasterMime, width: number, height: number): Promise<ImageBitmap> {
  const blob = new Blob([data.slice()], { type: mime });
  try {
    // Browser-side high-quality resampling while decoding (Chromium).
    return await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  } catch {
    return createImageBitmap(blob);
  }
}

function canvasToBytes(canvas: AnyCanvas, mime: RasterMime, quality: number): Promise<Uint8Array> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: mime, quality }).then(async (b) => new Uint8Array(await b.arrayBuffer()));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Could not encode ${mime}`));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      mime,
      quality,
    );
  });
}

export function createCanvasCodec(): ImageCodec<CanvasSurface> {
  return {
    async render(data, mime, width, height) {
      const bitmap = await decode(data, mime, width, height);
      try {
        const canvas = makeCanvas(width, height);
        const ctx = context2d(canvas);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, width, height);
        return { width, height, canvas, ctx };
      } finally {
        bitmap.close();
      }
    },
    hasTransparency(s) {
      const rows = Math.max(1, Math.floor(CONFIG.ui.imageAlphaScanBandPx / Math.max(1, s.width)));
      for (let y = 0; y < s.height; y += rows) {
        const h = Math.min(rows, s.height - y);
        if (rgbaHasTransparency(s.ctx.getImageData(0, y, s.width, h).data)) return true;
      }
      return false;
    },
    encode(s, mime, quality) {
      return canvasToBytes(s.canvas, mime, quality);
    },
    release(s) {
      // Free the backing store right away (large canvases are otherwise kept until GC).
      s.canvas.width = 0;
      s.canvas.height = 0;
    },
  };
}
