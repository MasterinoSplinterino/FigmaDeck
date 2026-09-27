/**
 * UI-side image compression before the PPTX / image PDF is built (browser only at runtime; the
 * planning and selection logic is pure and the codec / compressor are injectable, so the module is
 * testable in Node).
 *
 * Assets with role `image-fill`, `background`, `raster` or `vector-fallback` (PNG / JPEG; never SVG
 * or GIF):
 * - image fills larger than displayWidth/Height × rasterScale × CONFIG.raster.maxImageOversample are
 *   downscaled first (aspect kept; crops are fractions, so they stay valid);
 * - compression `off`: bytes kept as exported; a downscaled bitmap is re-encoded in its own format
 *   (PNG losslessly, JPEG at CONFIG.ui.imageReencodeJpegQuality);
 * - `balanced` / `strong` (TinyPNG-like), for PNG originals — candidates, smallest acceptable kept:
 *     (a) ≤ 256 colours → exact palette PNG (lossless);
 *     (b) opaque image-fill / background / raster → JPEG at `jpegQualityFor(options)` (canvas);
 *     (c) lossy palette PNG behind the level's quality gate (src/compress, `maxBytes` = best so far);
 *     (d) lossless PNG re-encode.
 *   (a), (c), (d) run in the compression worker (src/ui/compress-job.ts has the skipping rules). JPEG
 *   is never used for transparent bitmaps nor vector fallbacks, and must be ≤
 *   CONFIG.raster.jpegMinSavingRatio × the best PNG (PNG keeps edges and text sharp). Nothing larger
 *   than the original bytes is ever kept. JPEG originals are re-encoded only when downscaled.
 * - Image-only targets (pptx-image / pdf-image): every slide picture (`background`) becomes a JPEG
 *   at `jpegQualityFor(options)`, whatever the compression level. Transparent pixels (rounded
 *   corners, a translucent frame) are first flattened onto the slide's background colour — white when
 *   it has none (`slideMattes`), i.e. what PowerPoint / the PDF page shows behind them.
 */
import { hasTransparency, type CompressLevel, type RgbaPixels } from '../compress';
import { CONFIG } from '../config';
import type { Asset, AssetMime, AssetRole, Element, Slide } from '../ir/types';
import type { ExportSettings } from '../shared/settings';
import { CompressCancelledError, inThreadCompressor, type CompressMethod, type PixelCompressor, type PixelResult } from './compress-job';
import type { AssetStat, ImageStats } from './report';

export type Compression = ExportSettings['compression'];

/** Opaque colour, 0..1 channels (the IR's convention). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const WHITE: Rgb = { r: 1, g: 1, b: 1 };

export interface ImageOptions {
  rasterScale: 1 | 2 | 3;
  compression: Compression;
  /** 0..1 (`strong` caps it at CONFIG.ui.imageStrongJpegQuality). */
  jpegQuality: number;
  /** Image-only targets (pptx-image / pdf-image): every slide picture becomes a JPEG. */
  imageTarget?: boolean;
  /** Image-only targets: colour behind each slide picture (asset id → colour; missing = white), see `slideMattes`. */
  mattes?: Readonly<Record<string, Rgb>>;
}

export interface AssetPlan {
  /** Target bitmap size (px); the current size when not downscaling. */
  width: number;
  height: number;
  downscale: boolean;
  /**
   * `resample`: only re-encode the downscaled bitmap in its own format (compression off, JPEG
   * originals); `compress`: the full candidate search.
   */
  kind: 'resample' | 'compress';
}

const PROCESSABLE_ROLES: ReadonlySet<AssetRole> = new Set<AssetRole>(['image-fill', 'background', 'raster', 'vector-fallback']);
/** Roles that may become JPEG (when opaque). Vector fallbacks stay PNG. */
const JPEG_ROLES: ReadonlySet<AssetRole> = new Set<AssetRole>(['image-fill', 'background', 'raster']);

export type RasterMime = 'image/png' | 'image/jpeg';

function isRasterMime(mime: AssetMime): mime is RasterMime {
  return mime === 'image/png' || mime === 'image/jpeg';
}

/** A whole-slide picture of an image-only target: always encoded as JPEG. */
function isSlidePicture(role: AssetRole, options: Pick<ImageOptions, 'imageTarget'>): boolean {
  return !!options.imageTarget && role === 'background';
}

/** An opaque colour: `c` composited over white (alpha < 1 only happens for hand-made IR). */
function opaque(c: { r: number; g: number; b: number; a?: number }): Rgb {
  const a = typeof c.a === 'number' ? Math.max(0, Math.min(1, c.a)) : 1;
  return { r: c.r * a + (1 - a), g: c.g * a + (1 - a), b: c.b * a + (1 - a) };
}

/**
 * Image-only targets: the colour each slide picture sits on — the slide's solid background (as
 * PowerPoint draws it, and as the image PDF paints the page), white when the slide has none (a frame
 * with rounded corners or without a fill). Keyed by asset id; the first slide showing an asset wins.
 */
export function slideMattes(slides: readonly Slide[]): Record<string, Rgb> {
  const out: Record<string, Rgb> = {};
  const visit = (elements: readonly Element[], matte: Rgb) => {
    for (const e of elements) {
      if (e.type === 'image') {
        if (!(e.assetId in out)) out[e.assetId] = matte;
      } else if (e.type === 'group') visit(e.children, matte);
    }
  };
  for (const s of slides) visit(s.elements, s.background ? opaque(s.background.color) : WHITE);
  return out;
}

/** JPEG quality of a compression level (strong: capped at CONFIG.ui.imageStrongJpegQuality). */
export function jpegQualityFor(options: Pick<ImageOptions, 'compression' | 'jpegQuality'>): number {
  return options.compression === 'strong' ? Math.min(options.jpegQuality, CONFIG.ui.imageStrongJpegQuality) : options.jpegQuality;
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
  // Compression off (except for the slide pictures of image targets, which always become JPEG), or a
  // JPEG original (JPEG → JPEG is generation loss): only a downscale is worth it.
  if ((options.compression === 'off' && !isSlidePicture(asset.role, options)) || asset.mime === 'image/jpeg') {
    return target ? { ...target, downscale: true, kind: 'resample' } : null;
  }
  return { width: target?.width ?? asset.width, height: target?.height ?? asset.height, downscale: target !== null, kind: 'compress' };
}

// ─── Selection ───────────────────────────────────────────────────────────────

export interface CandidateSize {
  method: Exclude<CompressMethod, 'original'>;
  bytes: number;
}

/**
 * Pick the encoding to keep (pure):
 * - the smallest PNG candidate (palette / lossless) competes with the JPEG;
 * - JPEG wins only when ≤ `ratio` × the best PNG (the original counts when it is a PNG);
 * - a result that is not smaller than the original bytes is discarded (keep the original).
 */
export function pickEncoding(original: { bytes: number; mime: RasterMime }, candidates: readonly CandidateSize[], ratio: number = CONFIG.raster.jpegMinSavingRatio): CompressMethod {
  let png: CandidateSize | null = null;
  let jpeg: CandidateSize | null = null;
  for (const c of candidates) {
    if (c.method === 'jpeg') {
      if (!jpeg || c.bytes < jpeg.bytes) jpeg = c;
    } else if (!png || c.bytes < png.bytes) png = c;
  }
  const pngReference = Math.min(png?.bytes ?? Infinity, original.mime === 'image/png' ? original.bytes : Infinity);
  const best = jpeg && jpeg.bytes <= ratio * pngReference ? jpeg : png;
  return best && best.bytes < original.bytes ? best.method : 'original';
}

/** A decoded (possibly downscaled) bitmap and what it was exported as. */
export interface BitmapInput {
  /** Straight RGBA. Transferred to the worker by the pixel job: detached afterwards. */
  rgba: RgbaPixels;
  width: number;
  height: number;
  role: AssetRole;
  original: { bytes: number; mime: RasterMime };
  /** Image-only targets: colour a transparent slide picture is flattened onto (default white). */
  matte?: Rgb;
}

export interface SelectDeps {
  compressor: PixelCompressor;
  /** JPEG of the bitmap (canvas). Called at most once, before the pixel job. */
  encodeJpeg: (quality: number) => Promise<Uint8Array>;
  /**
   * Composite the bitmap source (what `encodeJpeg` encodes) onto an opaque colour. Used for the
   * transparent slide pictures of image targets; without it they keep the PNG candidates.
   */
  flatten?: (matte: Rgb) => void | Promise<void>;
  /** The bitmap source (canvas) is no longer needed: called before the (slow) pixel job. */
  release?: () => void;
  signal?: AbortSignal;
}

export interface Selection {
  method: CompressMethod;
  /** New bytes, or null to keep the original. */
  bytes: Uint8Array | null;
  mime: RasterMime;
  transparent: boolean;
  /** The pixel job's report (null when none ran). */
  job: PixelResult | null;
}

/**
 * Choose the encoding of one PNG bitmap (see the module comment): JPEG candidate on the canvas first
 * (it bounds the PNG search via `maxBytes`), then one pixel job, then `pickEncoding`.
 */
export async function selectEncoding(input: BitmapInput, options: ImageOptions, deps: SelectDeps): Promise<Selection> {
  const transparent = hasTransparency(input.rgba);
  const keep = (job: PixelResult | null): Selection => ({ method: 'original', bytes: null, mime: input.original.mime, transparent, job });
  if (isSlidePicture(input.role, options) && (!transparent || deps.flatten)) {
    // Image targets: one JPEG per slide, always (even when a PNG would be smaller).
    if (transparent) await deps.flatten!(input.matte ?? WHITE);
    const bytes = await deps.encodeJpeg(jpegQualityFor(options));
    deps.release?.();
    return { method: 'jpeg', bytes, mime: 'image/jpeg', transparent: false, job: null };
  }
  if (options.compression === 'off') {
    deps.release?.();
    return keep(null);
  }
  const level: CompressLevel = options.compression;
  const jpeg = JPEG_ROLES.has(input.role) && !transparent ? await deps.encodeJpeg(jpegQualityFor(options)) : null;
  deps.release?.();

  const candidates: Array<{ method: Exclude<CompressMethod, 'original'>; bytes: Uint8Array }> = [];
  if (jpeg) candidates.push({ method: 'jpeg', bytes: jpeg });
  // A PNG is useful only when smaller than the original and than JPEG / ratio (see pickEncoding).
  const maxBytes = Math.min(input.original.bytes, jpeg ? jpeg.byteLength / CONFIG.raster.jpegMinSavingRatio : Infinity);
  const job = await deps.compressor.run(
    { rgba: input.rgba, width: input.width, height: input.height, level, maxBytes, originalBytes: input.original.bytes, hasJpeg: jpeg !== null },
    deps.signal,
  );
  if (job.method && job.bytes) candidates.push({ method: job.method, bytes: job.bytes });
  const method = pickEncoding(
    input.original,
    candidates.map((c) => ({ method: c.method, bytes: c.bytes.byteLength })),
  );
  const chosen = candidates.find((c) => c.method === method);
  if (!chosen) return keep(job);
  return { method, bytes: chosen.bytes, mime: method === 'jpeg' ? 'image/jpeg' : 'image/png', transparent, job };
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
  /** Straight RGBA of the surface (a fresh buffer the caller owns). */
  pixels(surface: S): RgbaPixels;
  encode(surface: S, mime: RasterMime, quality: number): Promise<Uint8Array>;
  /** Composite the surface onto an opaque colour (no transparent pixels left). */
  flatten(surface: S, matte: Rgb): void;
  release(surface: S): void;
}

export interface AssetResult {
  asset: Asset;
  stat: AssetStat;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Process one asset according to its plan. Returns the (possibly new) asset object and its stat. */
export async function processAsset<S extends Surface>(
  asset: Asset,
  plan: AssetPlan,
  options: ImageOptions,
  codec: ImageCodec<S>,
  compressor: PixelCompressor,
  signal?: AbortSignal,
): Promise<AssetResult> {
  const t0 = now();
  const mime = asset.mime as RasterMime;
  const surface = await codec.render(asset.data, mime, plan.width, plan.height);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    codec.release(surface);
  };
  try {
    let method: CompressMethod;
    let bytes: Uint8Array | null;
    let outMime: RasterMime = mime;
    let hasAlpha = asset.hasAlpha;
    let colors: number | undefined;
    if (plan.kind === 'resample') {
      const isJpeg = mime === 'image/jpeg';
      const quality = isJpeg ? (options.compression === 'off' ? CONFIG.ui.imageReencodeJpegQuality : jpegQualityFor(options)) : 1;
      const data = await codec.encode(surface, mime, quality);
      release();
      method = pickEncoding({ bytes: asset.data.byteLength, mime }, [{ method: isJpeg ? 'jpeg' : 'lossless', bytes: data.byteLength }]);
      bytes = method === 'original' ? null : data;
    } else {
      const input: BitmapInput = { rgba: codec.pixels(surface), width: surface.width, height: surface.height, role: asset.role, original: { bytes: asset.data.byteLength, mime } };
      const matte = options.mattes?.[asset.id];
      if (matte) input.matte = matte;
      const selection = await selectEncoding(input, options, {
        compressor,
        encodeJpeg: (q) => codec.encode(surface, 'image/jpeg', q),
        flatten: (m) => codec.flatten(surface, m),
        release,
        signal,
      });
      ({ method, bytes } = selection);
      outMime = selection.mime;
      hasAlpha = selection.transparent;
      colors = selection.job?.colors;
    }
    let next: Asset;
    if (!bytes) next = hasAlpha === asset.hasAlpha ? asset : { ...asset, hasAlpha };
    else next = { ...asset, data: bytes, mime: outMime, width: surface.width, height: surface.height, hasAlpha: outMime === 'image/jpeg' ? false : hasAlpha };
    const stat: AssetStat = {
      id: asset.id,
      role: asset.role,
      method,
      bytesBefore: asset.data.byteLength,
      bytesAfter: next.data.byteLength,
      ms: now() - t0,
      width: next.width,
      height: next.height,
      downscaled: plan.downscale && bytes !== null,
    };
    if (colors !== undefined) stat.colors = colors;
    return { asset: next, stat };
  } finally {
    release();
  }
}

/** Where the images phase is (the overlay shows "Compressing images i of N" + the bitmap size). */
export interface ImageProgress {
  width: number;
  height: number;
  /** Where pixel jobs run; null until the first one started. */
  thread: 'worker' | 'main' | null;
}

export interface ProcessHooks {
  /** Before each asset (`done` = assets finished, `current` = the one starting) and once at the end. */
  onProgress?: (done: number, total: number, current?: ImageProgress) => void;
  /** Checked before each asset; when true, processing stops with `ImagesCancelledError`. */
  isCancelled?: () => boolean;
  /** Aborts a running pixel job too (the worker is terminated). */
  signal?: AbortSignal;
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

export function emptyImageStats(compression: Compression): ImageStats {
  return {
    compression,
    examined: 0,
    downscaled: 0,
    failed: 0,
    methods: { original: 0, jpeg: 0, 'palette-exact': 0, 'palette-lossy': 0, lossless: 0 },
    bytesBefore: 0,
    bytesAfter: 0,
    ms: 0,
    thread: null,
    items: [],
  };
}

/**
 * Compress every eligible asset in place (`assets[id]` is replaced by a new object), sequentially,
 * with progress and a yield between assets. A failing asset is left unchanged. `compressor` runs the
 * pixel jobs (default: on this thread; the app passes the worker client).
 */
export async function processAssets<S extends Surface>(
  assets: Record<string, Asset>,
  options: ImageOptions,
  hooks: ProcessHooks = {},
  codec?: ImageCodec<S>,
  compressor?: PixelCompressor,
): Promise<ImageStats> {
  const t0 = now();
  const jobs: Array<{ id: string; plan: AssetPlan }> = [];
  for (const [id, asset] of Object.entries(assets)) {
    const plan = planAsset(asset, options);
    if (plan) jobs.push({ id, plan });
  }
  const stats = emptyImageStats(options.compression);
  stats.examined = jobs.length;
  if (jobs.length === 0) return stats;
  const backend = (codec ?? (createCanvasCodec() as unknown as ImageCodec<S>)) as ImageCodec<S>;
  const pause = hooks.yieldFn ?? macrotask;
  const runner = compressor ?? inThreadCompressor(pause);
  const cancelled = () => !!hooks.isCancelled?.() || !!hooks.signal?.aborted;
  for (let i = 0; i < jobs.length; i++) {
    if (cancelled()) throw new ImagesCancelledError();
    const { id, plan } = jobs[i];
    hooks.onProgress?.(i, jobs.length, { width: plan.width, height: plan.height, thread: runner.thread });
    const before = assets[id];
    try {
      const { asset, stat } = await processAsset(before, plan, options, backend, runner, hooks.signal);
      assets[id] = asset;
      stats.items.push(stat);
    } catch (e) {
      if (e instanceof CompressCancelledError || e instanceof ImagesCancelledError || cancelled()) throw new ImagesCancelledError();
      hooks.onError?.(before, e);
      stats.failed++;
      stats.items.push({
        id,
        role: before.role,
        method: 'original',
        bytesBefore: before.data.byteLength,
        bytesAfter: before.data.byteLength,
        ms: 0,
        width: before.width,
        height: before.height,
        downscaled: false,
        failed: true,
      });
    }
    const stat = stats.items[stats.items.length - 1];
    stats.bytesBefore += stat.bytesBefore;
    stats.bytesAfter += stat.bytesAfter;
    stats.methods[stat.method]++;
    if (stat.downscaled) stats.downscaled++;
    await pause();
  }
  hooks.onProgress?.(jobs.length, jobs.length);
  stats.thread = runner.thread;
  stats.ms = now() - t0;
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
    pixels(s) {
      return s.ctx.getImageData(0, 0, s.width, s.height).data;
    },
    encode(s, mime, quality) {
      return canvasToBytes(s.canvas, mime, quality);
    },
    flatten(s, m) {
      // Paint the colour BEHIND the bitmap: result = bitmap over colour, fully opaque.
      const channel = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
      s.ctx.save();
      s.ctx.globalCompositeOperation = 'destination-over';
      s.ctx.fillStyle = `rgb(${channel(m.r)}, ${channel(m.g)}, ${channel(m.b)})`;
      s.ctx.fillRect(0, 0, s.width, s.height);
      s.ctx.restore();
    },
    release(s) {
      // Free the backing store right away (large canvases are otherwise kept until GC).
      s.canvas.width = 0;
      s.canvas.height = 0;
    },
  };
}
