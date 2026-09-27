import { describe, expect, it, vi } from 'vitest';
import { CompressorClient, type WorkerFactory, type WorkerPort } from '../../src/ui/compress-client';
import { CompressCancelledError, handleWorkerRequest, runPixelJob, type PixelJob, type PixelResult, type WorkerRequest, type WorkerResponse } from '../../src/ui/compress-job';
import { flatIcon, smoothGradient } from '../compress/helpers';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FakeOptions {
  /** Post `ready` after loading (default true). */
  ready?: boolean;
  /** Report a load error instead (CSP refused the script…). */
  loadError?: string;
  /** Job handler inside the "worker" (default: the real one). */
  run?: (job: PixelJob) => PixelResult;
  /** Keep jobs pending until `flush()` is called. */
  manual?: boolean;
}

/**
 * A fake worker speaking the real protocol: messages cross a structuredClone boundary with the
 * transfer list (so transferred buffers are detached like in a browser) and arrive asynchronously.
 */
class FakeWorker implements WorkerPort {
  onmessage: WorkerPort['onmessage'] = null;
  onerror: WorkerPort['onerror'] = null;
  terminated = false;
  received: WorkerRequest[] = [];
  transfers: ArrayBuffer[][] = [];
  private queue: WorkerRequest[] = [];

  constructor(private readonly opts: FakeOptions = {}) {
    setTimeout(() => {
      if (this.terminated) return;
      if (opts.loadError) this.onerror?.({ message: opts.loadError });
      else if (opts.ready !== false) this.post({ type: 'ready' }, []);
    }, 0);
  }

  postMessage(message: WorkerRequest, transfer: ArrayBuffer[]): void {
    if (this.terminated) throw new Error('posted to a terminated worker');
    const cloned = structuredClone(message, { transfer });
    this.received.push(cloned);
    this.transfers.push(transfer);
    if (this.opts.manual) this.queue.push(cloned);
    else setTimeout(() => this.answer(cloned), 0);
  }

  flush(): void {
    for (const m of this.queue.splice(0)) this.answer(m);
  }

  crash(message: string): void {
    this.onerror?.({ message });
  }

  terminate(): void {
    this.terminated = true;
  }

  private answer(msg: WorkerRequest): void {
    if (this.terminated) return;
    const answer = handleWorkerRequest(msg, this.opts.run ?? ((job) => runPixelJob(job)));
    if (answer) this.post(answer.response, answer.transfer);
  }

  private post(response: WorkerResponse, transfer: ArrayBuffer[]): void {
    const data = structuredClone(response, { transfer });
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data });
    }, 0);
  }
}

function factories(...opts: Array<FakeOptions | 'throw'>): { list: WorkerFactory[]; created: FakeWorker[]; calls: number[] } {
  const created: FakeWorker[] = [];
  const calls: number[] = [];
  const list = opts.map((o, i) => () => {
    calls.push(i);
    if (o === 'throw') throw new Error('Refused to create a worker (CSP)');
    const w = new FakeWorker(o);
    created.push(w);
    return w;
  });
  return { list, created, calls };
}

function gradientJob(w = 48, h = 36): PixelJob {
  return { rgba: smoothGradient(w, h), width: w, height: h, level: 'balanced', maxBytes: 1e9, originalBytes: 1e9, hasJpeg: false };
}

const noYield = () => Promise.resolve();

describe('handleWorkerRequest', () => {
  it('answers compress requests with the job result and transfers the PNG bytes', () => {
    const job = gradientJob();
    const answer = handleWorkerRequest({ type: 'compress', id: 7, job })!;
    expect(answer.response.type).toBe('result');
    if (answer.response.type !== 'result') return;
    expect(answer.response.id).toBe(7);
    expect(answer.response.result.method).toBe('palette-lossy');
    expect(answer.transfer).toEqual([answer.response.result.bytes!.buffer]);
  });

  it('reports job errors and ignores anything that is not a request', () => {
    const answer = handleWorkerRequest({ type: 'compress', id: 3, job: gradientJob() }, () => {
      throw new RangeError('bad size');
    });
    expect(answer).toEqual({ response: { type: 'error', id: 3, message: 'bad size' }, transfer: [] });
    expect(handleWorkerRequest(null)).toBeNull();
    expect(handleWorkerRequest({ type: 'ready' })).toBeNull();
    expect(handleWorkerRequest({ type: 'compress', id: 'x', job: {} })).toBeNull();
  });
});

describe('CompressorClient', () => {
  it('runs jobs in one reused worker; pixels go in and PNG bytes come back as transfers', async () => {
    const f = factories({});
    const client = new CompressorClient(f.list);
    expect(client.thread).toBeNull();
    const job = gradientJob();
    const expected = runPixelJob({ ...job, rgba: job.rgba.slice() });
    const r1 = await client.run(job);
    expect(client.thread).toBe('worker');
    expect(r1.method).toBe(expected.method);
    expect(Array.from(r1.bytes!)).toEqual(Array.from(expected.bytes!));
    expect(job.rgba.byteLength).toBe(0); // transferred (detached), not copied
    const flat = flatIcon(20, 10, [
      [1, 2, 3, 255],
      [4, 5, 6, 255],
    ]);
    const r2 = await client.run({ ...gradientJob(), rgba: flat, width: 20, height: 10 });
    expect(r2.method).toBe('palette-exact');
    expect(f.calls).toEqual([0]); // one worker for both jobs
    expect(f.created[0].received.map((m) => m.id)).toEqual([1, 2]);
    expect(f.created[0].transfers[0]).toHaveLength(1);
  });

  it('a view that does not own its whole buffer is copied, not transferred', async () => {
    const f = factories({});
    const client = new CompressorClient(f.list);
    const whole = smoothGradient(20, 10);
    const padded = new Uint8Array(whole.length + 16);
    padded.set(whole, 16);
    const view = padded.subarray(16);
    await client.run({ ...gradientJob(), rgba: view, width: 20, height: 10 });
    expect(f.created[0].transfers[0]).toEqual([]);
    expect(padded.byteLength).toBe(whole.length + 16);
  });

  it('falls back to the next factory, then to the main thread', async () => {
    const failures: string[] = [];
    const f = factories('throw', { loadError: 'blocked by CSP' });
    const fallback = vi.fn((job: PixelJob) => runPixelJob(job));
    const client = new CompressorClient(f.list, { fallback, yieldFn: noYield, onStartFailure: (i, reason) => failures.push(`${i}: ${reason}`) });
    const job = gradientJob();
    const r = await client.run(job);
    expect(r.method).toBe('palette-lossy');
    expect(client.thread).toBe('main');
    expect(fallback).toHaveBeenCalledOnce();
    expect(failures).toEqual(['0: Refused to create a worker (CSP)', '1: blocked by CSP']);
    expect(f.created[0].terminated).toBe(true);
    expect(f.created[0].received).toHaveLength(0); // pixels never sent to a worker that did not start
    expect(job.rgba.byteLength).toBeGreaterThan(0);
    // Later jobs go straight to the main thread.
    await client.run(gradientJob());
    expect(f.calls).toEqual([0, 1]);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('a worker that never says ready is given up after the start timeout', async () => {
    const f = factories({ ready: false }, {});
    const timers: Array<() => void> = [];
    const client = new CompressorClient(f.list, {
      startTimeoutMs: 5000,
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => undefined,
    });
    const pending = client.run(gradientJob());
    await tick();
    expect(timers).toHaveLength(1);
    timers[0](); // start timeout of the silent worker
    const r = await pending;
    expect(r.method).toBe('palette-lossy');
    expect(f.created[0].terminated).toBe(true);
    expect(client.thread).toBe('worker'); // the second factory's worker
    expect(f.created[1].received).toHaveLength(1);
  });

  it('no factories (no Worker in this environment) → main thread', async () => {
    const client = new CompressorClient([], { yieldFn: noYield });
    const r = await client.run(gradientJob());
    expect(r.method).toBe('palette-lossy');
    expect(client.thread).toBe('main');
  });

  it('cancel: terminates the worker, rejects the job; the next job starts a new worker', async () => {
    const f = factories({ manual: true });
    const client = new CompressorClient(f.list);
    const controller = new AbortController();
    const pending = client.run(gradientJob(), controller.signal);
    await vi.waitFor(() => expect(f.created[0]?.received).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CompressCancelledError);
    expect(f.created[0].terminated).toBe(true);
    f.created[0].flush(); // a late answer from the terminated worker is ignored
    const next = client.run(gradientJob());
    await vi.waitFor(() => expect(f.created[1]?.received).toHaveLength(1));
    f.created[1].flush();
    expect((await next).method).toBe('palette-lossy');
    expect(f.calls).toEqual([0, 0]); // same way of starting, new worker
  });

  it('an already aborted signal rejects without starting a worker', async () => {
    const f = factories({});
    const client = new CompressorClient(f.list);
    const controller = new AbortController();
    controller.abort();
    await expect(client.run(gradientJob(), controller.signal)).rejects.toBeInstanceOf(CompressCancelledError);
    expect(f.calls).toEqual([]);
  });

  it('a crash mid-job fails that job only; the next job gets a fresh worker', async () => {
    const f = factories({ manual: true });
    const client = new CompressorClient(f.list);
    const pending = client.run(gradientJob());
    await vi.waitFor(() => expect(f.created[0]?.received).toHaveLength(1));
    f.created[0].crash('out of memory');
    await expect(pending).rejects.toThrow('Compression worker failed: out of memory');
    expect(f.created[0].terminated).toBe(true);
    const next = client.run(gradientJob());
    await vi.waitFor(() => expect(f.created[1]?.received).toHaveLength(1));
    f.created[1].flush();
    expect((await next).method).toBe('palette-lossy');
    expect(client.thread).toBe('worker');
  });

  it('a job error inside the worker rejects with its message', async () => {
    const f = factories({
      run: () => {
        throw new Error('rgba shorter than width × height × 4');
      },
    });
    const client = new CompressorClient(f.list);
    await expect(client.run(gradientJob())).rejects.toThrow('rgba shorter than width × height × 4');
    // The worker survives a job error.
    expect(f.created[0].terminated).toBe(false);
  });

  it('dispose terminates the worker for good (later jobs run on the main thread)', async () => {
    const f = factories({});
    const client = new CompressorClient(f.list, { yieldFn: noYield });
    await client.run(gradientJob());
    client.dispose();
    expect(f.created[0].terminated).toBe(true);
    await client.run(gradientJob());
    expect(client.thread).toBe('main');
    expect(f.calls).toEqual([0]);
  });
});
