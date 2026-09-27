/**
 * One pixel-compression job (palette / lossless PNG candidates of a decoded bitmap) and the message
 * protocol of the compression worker. Environment-neutral: runs in the worker
 * (src/ui/compress.worker.ts), on the UI main thread when no worker can be started, and in Node tests.
 *
 * Steps of `runPixelJob` (the JPEG candidate is made by the caller on a canvas, before the job):
 *   1. ≤ 256 distinct colours → exact palette (`optimizeLossless`, lossless); nothing can beat it.
 *   2. With a JPEG candidate and more than CONFIG.ui.imagePaletteMaxColorsWithJpeg colours (a photo or
 *      a smooth gradient) → stop: JPEG wins.
 *   3. Above CONFIG.ui.imageCompressMaxPixels → stop (time / memory).
 *   4. Lossy palette: `compressRgba(level, { maxBytes })` (quality gate; null when it fails or is not smaller).
 *   5. Lossless re-encode, unless the palette already is ≤ CONFIG.ui.imageLosslessSkipRatio × the original.
 * A candidate is kept only when smaller than `maxBytes` and than the previous one.
 */
import { compressRgba, countColors, optimizeLossless, type CompressLevel, type RgbaPixels } from '../compress';
import { CONFIG } from '../config';

/** PNG candidates made from the pixels. */
export type PixelMethod = 'palette-exact' | 'palette-lossy' | 'lossless';

/** What an asset ended up as (`original` = bytes kept as exported). */
export type CompressMethod = 'original' | 'jpeg' | PixelMethod;

export interface PixelJob {
  /** Straight RGBA, 4 bytes per pixel (transferred to the worker: detached afterwards). */
  rgba: RgbaPixels;
  width: number;
  height: number;
  level: CompressLevel;
  /** A candidate is kept only when smaller than this many bytes (the original, or what beats the JPEG). */
  maxBytes: number;
  /** Size of the bytes as exported (decides whether the lossless re-encode is worth trying). */
  originalBytes: number;
  /** A JPEG candidate exists (opaque photo / background / raster). */
  hasJpeg: boolean;
}

export interface PixelResult {
  /** Best candidate, or null when none is smaller than `maxBytes`. */
  method: PixelMethod | null;
  bytes: Uint8Array | null;
  /** Distinct colours, counted up to the step's limit (a larger value means "more"). */
  colors: number;
  /** Steps run, in order (diagnostics and tests): count, palette-exact, skip:jpeg, skip:size, palette-lossy, lossless. */
  steps: string[];
  ms: number;
}

/** Codec functions (injectable for tests). */
export interface PixelLib {
  compressRgba: typeof compressRgba;
  countColors: typeof countColors;
  optimizeLossless: typeof optimizeLossless;
}

const LIB: PixelLib = { compressRgba, countColors, optimizeLossless };

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function runPixelJob(job: PixelJob, lib: PixelLib = LIB): PixelResult {
  const t0 = now();
  const { rgba, width, height } = job;
  const steps: string[] = ['count'];
  const flatLimit = CONFIG.ui.imagePaletteMaxColorsWithJpeg;
  const colors = lib.countColors(rgba, job.hasJpeg ? Math.max(256, flatLimit) : 256);
  let best: { method: PixelMethod; bytes: Uint8Array } | null = null;
  const consider = (method: PixelMethod, bytes: Uint8Array | null | undefined) => {
    if (bytes && bytes.length < (best ? best.bytes.length : job.maxBytes)) best = { method, bytes };
  };
  const done = (): PixelResult => {
    const b = best as { method: PixelMethod; bytes: Uint8Array } | null;
    return { method: b?.method ?? null, bytes: b?.bytes ?? null, colors, steps, ms: now() - t0 };
  };

  if (colors <= 256) {
    steps.push('palette-exact');
    consider('palette-exact', lib.optimizeLossless(rgba, width, height));
    return done();
  }
  if (job.hasJpeg && colors > flatLimit) {
    steps.push('skip:jpeg');
    return done();
  }
  if (width * height > CONFIG.ui.imageCompressMaxPixels) {
    steps.push('skip:size');
    return done();
  }
  steps.push('palette-lossy');
  const lossy = lib.compressRgba(rgba, width, height, job.level, { maxBytes: job.maxBytes });
  if (lossy) consider(lossy.lossless ? 'palette-exact' : 'palette-lossy', lossy.bytes);
  const kept = best as { bytes: Uint8Array } | null;
  if (!kept || kept.bytes.length > CONFIG.ui.imageLosslessSkipRatio * job.originalBytes) {
    steps.push('lossless');
    consider('lossless', lib.optimizeLossless(rgba, width, height));
  }
  return done();
}

// ─── Worker protocol ─────────────────────────────────────────────────────────

/** UI → worker. */
export type WorkerRequest = { type: 'compress'; id: number; job: PixelJob };

/** Worker → UI. `ready` is posted once when the worker script has loaded. */
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: PixelResult }
  | { type: 'error'; id: number; message: string };

/**
 * Worker side: answer one request (the worker entry posts `response` with `transfer`). Returns null
 * for messages that are not requests.
 */
export function handleWorkerRequest(msg: unknown, run: (job: PixelJob) => PixelResult = runPixelJob): { response: WorkerResponse; transfer: ArrayBuffer[] } | null {
  const req = msg as Partial<WorkerRequest> | null;
  if (!req || req.type !== 'compress' || typeof req.id !== 'number' || !req.job) return null;
  try {
    const result = run(req.job);
    const transfer = result.bytes && result.bytes.buffer instanceof ArrayBuffer ? [result.bytes.buffer] : [];
    return { response: { type: 'result', id: req.id, result }, transfer };
  } catch (e) {
    const message = e instanceof Error ? e.message || e.name : String(e);
    return { response: { type: 'error', id: req.id, message }, transfer: [] };
  }
}

// ─── Compressor (where jobs run) ─────────────────────────────────────────────

/** Runs pixel jobs: a Web Worker (CompressorClient) or the current thread. */
export interface PixelCompressor {
  /** Where jobs ran / will run: known after the first job (`null` before). */
  readonly thread: 'worker' | 'main' | null;
  /**
   * Run one job. The job's pixels may be transferred (detached) — do not read them afterwards.
   * Rejects with `CompressCancelledError` when `signal` aborts.
   */
  run(job: PixelJob, signal?: AbortSignal): Promise<PixelResult>;
}

export class CompressCancelledError extends Error {
  constructor() {
    super('Image compression cancelled');
    this.name = 'CompressCancelledError';
  }
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Jobs on the current thread, after a yield (so a repaint / "Cancel" click can get through first). */
export function inThreadCompressor(yieldFn: () => Promise<void> = macrotask, run: (job: PixelJob) => PixelResult = runPixelJob): PixelCompressor {
  let used = false;
  return {
    get thread() {
      return used ? 'main' : null;
    },
    async run(job, signal) {
      if (signal?.aborted) throw new CompressCancelledError();
      await yieldFn();
      if (signal?.aborted) throw new CompressCancelledError();
      used = true;
      return run(job);
    },
  };
}
