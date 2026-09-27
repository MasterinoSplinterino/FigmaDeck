/**
 * UI side of the compression worker: one Web Worker, created lazily and reused for every job;
 * pixels go in and PNG bytes come back as transferred ArrayBuffers (no copies).
 *
 * Start-up: a worker is used only after it has posted `ready` (so no pixels are ever transferred to
 * a worker that failed to load). The factories are tried in order — a blob: URL, then a data: URL
 * (some sandboxed iframes refuse one or the other) — and a factory that throws, reports an error or
 * stays silent for CONFIG.ui.compressWorkerStartTimeoutMs is skipped. When none works, jobs run on
 * the main thread (`thread === 'main'`, the UI shows a note).
 *
 * Cancel: `cancel()` (or the job's AbortSignal) terminates the worker and rejects the pending job
 * with CompressCancelledError; the next job starts a fresh worker. A worker that crashes mid-job
 * (e.g. out of memory) fails that job only and is replaced for the next one.
 */
import { CONFIG } from '../config';
import { CompressCancelledError, runPixelJob, type PixelCompressor, type PixelJob, type PixelResult, type WorkerRequest, type WorkerResponse } from './compress-job';

/** The part of a DOM Worker the client uses (a fake in tests). */
export interface WorkerPort {
  postMessage(message: WorkerRequest, transfer: ArrayBuffer[]): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

/** Creates a worker; throws when the environment refuses (CSP, no Worker…). */
export type WorkerFactory = () => WorkerPort;

export interface ClientOptions {
  /** Ms to wait for `ready` (default CONFIG.ui.compressWorkerStartTimeoutMs). */
  startTimeoutMs?: number;
  /** Main-thread fallback (default: runPixelJob). */
  fallback?: (job: PixelJob) => PixelResult;
  /** Yield before a main-thread job (default: a macrotask). */
  yieldFn?: () => Promise<void>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** A way of starting the worker failed (index into the factories, reason). */
  onStartFailure?: (factory: number, reason: string) => void;
}

interface Pending {
  resolve: (r: PixelResult) => void;
  reject: (e: unknown) => void;
}

/** The pixel buffer is transferred when the view owns all of it (otherwise it is copied). */
function transferOf(job: PixelJob): ArrayBuffer[] {
  const { buffer, byteOffset, byteLength } = job.rgba;
  return buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength ? [buffer] : [];
}

export class CompressorClient implements PixelCompressor {
  private worker: WorkerPort | null = null;
  private starting: Promise<WorkerPort | null> | null = null;
  /** First factory still worth trying (failed ones are skipped for good). */
  private factoryIndex = 0;
  private mode: 'worker' | 'main' | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly startTimeoutMs: number;
  private readonly fallback: (job: PixelJob) => PixelResult;
  private readonly yieldFn: () => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly factories: readonly WorkerFactory[],
    private readonly options: ClientOptions = {},
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? CONFIG.ui.compressWorkerStartTimeoutMs;
    this.fallback = options.fallback ?? ((job) => runPixelJob(job));
    this.yieldFn = options.yieldFn ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get thread(): 'worker' | 'main' | null {
    return this.mode;
  }

  async run(job: PixelJob, signal?: AbortSignal): Promise<PixelResult> {
    if (signal?.aborted) throw new CompressCancelledError();
    const worker = this.factoryIndex < this.factories.length ? await this.ensureWorker() : null;
    if (signal?.aborted) throw new CompressCancelledError();
    if (!worker) {
      this.mode = 'main';
      await this.yieldFn();
      if (signal?.aborted) throw new CompressCancelledError();
      return this.fallback(job);
    }
    this.mode = 'worker';
    const id = this.nextId++;
    return new Promise<PixelResult>((resolve, reject) => {
      const onAbort = () => this.cancel();
      const settle = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        resolve: (r) => {
          settle();
          resolve(r);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      });
      signal?.addEventListener('abort', onAbort);
      try {
        worker.postMessage({ type: 'compress', id, job }, transferOf(job));
      } catch (e) {
        this.pending.delete(id);
        settle();
        reject(e);
      }
    });
  }

  /** Stop the running job (terminates the worker; the next job starts a new one). */
  cancel(): void {
    this.dropWorker(new CompressCancelledError());
  }

  /** Terminate the worker for good (pending jobs are cancelled). */
  dispose(): void {
    this.cancel();
    this.factoryIndex = this.factories.length;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private dropWorker(reason: unknown): void {
    const w = this.worker;
    this.worker = null;
    this.starting = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try {
        w.terminate();
      } catch {
        // already gone
      }
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(reason);
  }

  private ensureWorker(): Promise<WorkerPort | null> {
    if (this.worker) return Promise.resolve(this.worker);
    if (!this.starting) {
      const starting = this.startNext();
      this.starting = starting;
      starting.then((w) => {
        if (this.starting === starting) this.starting = null;
        return w;
      });
    }
    return this.starting;
  }

  /** Try the factories from `factoryIndex` on until one posts `ready`. */
  private async startNext(): Promise<WorkerPort | null> {
    while (this.factoryIndex < this.factories.length) {
      const index = this.factoryIndex;
      const w = await this.start(index);
      if (w) {
        this.worker = w;
        return w;
      }
      this.factoryIndex = index + 1;
    }
    return null;
  }

  private start(index: number): Promise<WorkerPort | null> {
    let w: WorkerPort;
    try {
      w = this.factories[index]();
    } catch (e) {
      this.options.onStartFailure?.(index, e instanceof Error ? e.message : String(e));
      return Promise.resolve(null);
    }
    return new Promise<WorkerPort | null>((resolve) => {
      let started = false;
      const fail = (reason: string) => {
        if (started) return;
        started = true;
        this.clearTimer(timer);
        w.onmessage = null;
        w.onerror = null;
        try {
          w.terminate();
        } catch {
          // ignore
        }
        this.options.onStartFailure?.(index, reason);
        resolve(null);
      };
      const timer = this.setTimer(() => fail('no ready message'), this.startTimeoutMs);
      w.onerror = (e) => fail(e.message || 'worker error');
      w.onmessage = (e) => {
        if (e.data?.type !== 'ready' || started) return;
        started = true;
        this.clearTimer(timer);
        w.onmessage = (ev) => this.onMessage(ev.data);
        w.onerror = (ev) => this.onCrash(w, ev.message || 'worker error');
        resolve(w);
      };
    });
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'ready') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'result') p.resolve(msg.result);
    else p.reject(new Error(msg.message));
  }

  /** The worker died after start-up: fail its jobs, start a new one next time. */
  private onCrash(w: WorkerPort, message: string): void {
    if (this.worker !== w) return;
    this.dropWorker(new Error(`Compression worker failed: ${message}`));
  }
}

/**
 * Factories for the bundled worker source: a blob: URL first, then a data: URL. Empty when the
 * environment has no Worker at all.
 */
export function browserWorkerFactories(code: string): WorkerFactory[] {
  if (typeof Worker === 'undefined' || !code) return [];
  let blobUrl: string | null = null;
  const wrap = (w: Worker): WorkerPort => {
    const port: WorkerPort = {
      postMessage: (m, transfer) => w.postMessage(m, transfer),
      terminate: () => w.terminate(),
      onmessage: null,
      onerror: null,
    };
    w.onmessage = (e: MessageEvent) => port.onmessage?.({ data: e.data as WorkerResponse });
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      port.onerror?.({ message: e.message });
    };
    return port;
  };
  return [
    () => {
      // One URL for the session: a cancelled worker is re-created from it.
      blobUrl ??= URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      return wrap(new Worker(blobUrl));
    },
    () => wrap(new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`)),
  ];
}
