import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPptx } from '../../src/build';
import type { BuildPptx } from '../../src/build/api';
import { deserializeDeck } from '../../src/ir/serialize';
import type { Asset, Deck, ReportEntry } from '../../src/ir/types';
import type { MainToUi, UiToMain } from '../../src/shared/messages';
import { DEFAULT_SETTINGS, type ExportFormat, type ExportSettings } from '../../src/shared/settings';
import { Exporter, type ExporterDeps, type ExporterEvent } from '../../src/ui/exporter';
import { setLang } from '../../src/ui/i18n';
import { emptyImageStats, type ProcessHooks } from '../../src/ui/images';
import { PPTX_MIME } from '../../src/ui/options';
import { imageDeckToPdf, mergePdfs } from '../../src/ui/pdf';
import type { ImageStats } from '../../src/ui/report';
import { loadFixture } from '../fixtures/load';

beforeAll(() => setLang('en'));

const noYield = () => Promise.resolve();
const STATS: ImageStats = emptyImageStats('balanced');

interface Harness {
  exporter: Exporter;
  events: ExporterEvent[];
  sent: UiToMain[];
  downloads: Array<{ data: Uint8Array; fileName: string; mime: string }>;
  timers: Array<() => void>;
  deps: ExporterDeps;
  feed: (...msgs: MainToUi[]) => void;
  settled: () => Promise<ExporterEvent>;
}

function harness(overrides: Partial<ExporterDeps> = {}): Harness {
  const events: ExporterEvent[] = [];
  const sent: UiToMain[] = [];
  const downloads: Harness['downloads'] = [];
  const timers: Array<() => void> = [];
  let clock = 1000;
  const waiters: Array<(e: ExporterEvent) => void> = [];
  const deps: ExporterDeps = {
    send: (m) => sent.push(m),
    buildPptx,
    processAssets: async () => ({ ...STATS }),
    mergePdfs: (parts, meta, hooks) => mergePdfs(parts, meta, { ...hooks, yieldFn: noYield }),
    imageDeckToPdf: (deck, meta, hooks) => imageDeckToPdf(deck, meta, { ...hooks, yieldFn: noYield }),
    download: (data, fileName, mime) => downloads.push({ data, fileName, mime }),
    now: () => (clock += 250),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => undefined,
    ...overrides,
  };
  const exporter = new Exporter(deps, (e) => {
    events.push(e);
    if (e.type !== 'progress') waiters.splice(0).forEach((w) => w(e));
  });
  return {
    exporter,
    events,
    sent,
    downloads,
    timers,
    deps,
    feed: (...msgs) => msgs.forEach((m) => exporter.handle(m)),
    settled: () => {
      const last = events.find((e) => e.type !== 'progress');
      return last ? Promise.resolve(last) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const settings = (o: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_SETTINGS, ...o });

function extractedMessages(deck: Deck, report: ReportEntry[] = [], format: ExportFormat = 'pptx'): MainToUi[] {
  const assets = Object.values(deck.assets);
  return [
    { type: 'export-started', format, total: deck.slides.length },
    ...deck.slides.map((slide, index): MainToUi => ({ type: 'export-slide', index, total: deck.slides.length, slide, assets: index === 0 ? assets : [] })),
    { type: 'export-extracted', meta: { title: deck.meta.title, author: 'Main Author' }, report },
  ];
}

const EXTRACT_REPORT: ReportEntry[] = [
  { level: 'raster', code: 'rasterized', slideId: '20:1', slideName: 'Kitchen sink', nodeName: 'Blob', reasons: ['blur'], message: 'x' },
];

describe('Exporter: PPTX', () => {
  it('extract → images → buildPptx → download → report', async () => {
    const deck = loadFixture('kitchen-sink');
    const processAssets = vi.fn(async (assets: Record<string, Asset>, _o: unknown, hooks: ProcessHooks) => {
      const n = Object.keys(assets).length;
      hooks.onProgress?.(0, n, { width: 400, height: 300, thread: null });
      hooks.onProgress?.(1, n, { width: 96, height: 96, thread: 'worker' });
      hooks.onProgress?.(n, n);
      return { ...STATS, examined: n };
    });
    const h = harness({ processAssets });
    expect(h.exporter.start('pptx', settings({ author: 'Ann', rasterScale: 3, jpeg: true }), '  Q3: Review ')).toBe(true);
    expect(h.exporter.busy).toBe(true);
    expect(h.sent).toEqual([{ type: 'start-export', format: 'pptx', settings: expect.objectContaining({ rasterScale: 3, jpeg: true }) }]);

    h.feed({ type: 'export-progress', phase: 'extract', done: 0, total: 1, label: 'Kitchen sink — 12 layers' });
    h.feed(...extractedMessages(deck, EXTRACT_REPORT));
    const done = await h.settled();

    expect(done.type).toBe('done');
    if (done.type !== 'done') return;
    const o = done.outcome;
    expect(o.fileName).toBe('Q3 Review.pptx');
    expect(o.mime).toBe(PPTX_MIME);
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]).toMatchObject({ fileName: 'Q3 Review.pptx', mime: PPTX_MIME });
    expect(h.downloads[0].data).toBe(o.data);
    expect([o.data[0], o.data[1]]).toEqual([0x50, 0x4b]);
    expect(o.slideCount).toBe(1);
    expect(o.slideIds).toEqual(['20:1']);
    expect(o.stats?.slides).toBe(1);
    expect(o.fonts.length).toBeGreaterThan(0);
    expect(o.entries[0]).toEqual(EXTRACT_REPORT[0]);
    expect(o.durationMs).toBeGreaterThan(0);
    expect(o.images?.examined).toBe(Object.keys(deck.assets).length);
    expect(processAssets).toHaveBeenCalledWith(
      expect.any(Object),
      { rasterScale: 3, compression: 'balanced', jpegQuality: DEFAULT_SETTINGS.jpegQuality, imageTarget: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(h.exporter.busy).toBe(false);
    // "Compressing images i of N" + the bitmap size in the overlay.
    const imageSteps = h.events.flatMap((e) => (e.type === 'progress' && e.progress.phase === 'images' ? [e.progress] : []));
    expect(imageSteps.map((p) => [p.done, p.image?.width ?? null, !!p.mainThread])).toEqual([
      [0, 400, false],
      [1, 96, false],
      [imageSteps[2].total, null, false],
    ]);

    // Metadata: deck title from the UI, author from the settings.
    const zip = await JSZip.loadAsync(o.data);
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(core).toContain('Q3: Review');
    expect(core).toContain('Ann');

    const phases = h.events.filter((e): e is Extract<ExporterEvent, { type: 'progress' }> => e.type === 'progress').map((e) => e.progress.phase);
    expect(phases[0]).toBe('starting');
    const order = ['extract', 'images', 'build', 'package'];
    const firstIndex = order.map((p) => phases.indexOf(p as never));
    expect(firstIndex.every((i) => i >= 0)).toBe(true);
    expect([...firstIndex].sort((a, b) => a - b)).toEqual(firstIndex);
  });

  it('assets re-sent by a later slide replace the earlier copy', async () => {
    const deck = loadFixture('kitchen-sink');
    let seen: Record<string, Asset> = {};
    const h = harness({
      processAssets: async (assets) => {
        seen = { ...assets };
        return { ...STATS };
      },
    });
    h.exporter.start('pptx', settings(), 'x');
    const photo = deck.assets.photo;
    const bigger: Asset = { ...photo, displayWidth: 999 };
    h.feed(
      { type: 'export-started', format: 'pptx', total: 2 },
      { type: 'export-slide', index: 0, total: 2, slide: deck.slides[0], assets: Object.values(deck.assets) },
      { type: 'export-slide', index: 1, total: 2, slide: { ...deck.slides[0], id: 'copy' }, assets: [bigger] },
      { type: 'export-extracted', meta: { title: 't' }, report: [] },
    );
    const done = await h.settled();
    expect(done.type).toBe('done');
    expect(seen.photo.displayWidth).toBe(999);
    expect(Object.keys(seen).sort()).toEqual(Object.keys(deck.assets).sort());
  });

  it('editable PowerPoint never runs in image mode (an old persisted "Image only" counts as Editable)', () => {
    const h = harness();
    h.exporter.start('pptx', settings({ mode: 'image' }), 'x');
    const msg = h.sent[0];
    expect(msg.type === 'start-export' && msg.settings.mode).toBe('editable');
    const h2 = harness();
    h2.exporter.start('pptx', settings({ mode: 'exact' }), 'x');
    expect(h2.sent[0].type === 'start-export' && h2.sent[0].settings.mode).toBe('exact');
  });

  it('localizes main progress from its numeric fields (slide names from the UI)', () => {
    const h = harness();
    h.exporter.start('pptx', settings(), 'x', ['Title', 'Agenda']);
    const last = () => {
      const e = h.events[h.events.length - 1];
      if (e.type !== 'progress') throw new Error('no progress');
      return e.progress;
    };
    h.feed({ type: 'export-progress', phase: 'extract', done: 1, total: 2, label: 'Agenda — 120 layers', slide: 2, layers: 120, jobsDone: 0, jobsTotal: 0 });
    expect(last()).toMatchObject({ phase: 'extract', slide: 2, slideName: 'Agenda', layers: 120, detail: 'Agenda — 120 layers' });
    h.feed({ type: 'export-progress', phase: 'extract', done: 0, total: 2, label: 'Title — exporting 3/9', layers: 40, jobsDone: 3, jobsTotal: 9 });
    expect(last()).toMatchObject({ slideName: 'Title', jobsDone: 3, jobsTotal: 9 });
    // Without numeric fields main's text is kept as is.
    h.feed({ type: 'export-progress', phase: 'extract', done: 0, total: 2, label: 'Title — 5 layers' });
    expect(last()).toEqual({ format: 'pptx', phase: 'extract', done: 0, total: 2, detail: 'Title — 5 layers', cancelling: false });
  });

  it('image PowerPoint forces image mode + JPEG in start-export', () => {
    const h = harness();
    h.exporter.start('pptx-image', settings({ mode: 'editable', jpeg: false }), 'x');
    const msg = h.sent[0];
    expect(msg.type === 'start-export' && msg.settings.mode).toBe('image');
    expect(msg.type === 'start-export' && msg.settings.jpeg).toBe(true);
  });

  it('refuses a second export while one is running', () => {
    const h = harness();
    expect(h.exporter.start('pptx', settings(), 'x')).toBe(true);
    expect(h.exporter.start('pdf', settings(), 'x')).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it('builder failure → error event', async () => {
    const failing: BuildPptx = async () => {
      throw new Error('boom');
    };
    const h = harness({ buildPptx: failing });
    h.exporter.start('pptx', settings(), 'x');
    h.feed(...extractedMessages(loadFixture('tiny')));
    expect(await h.settled()).toEqual({ type: 'error', message: 'boom' });
    expect(h.downloads).toHaveLength(0);
    expect(h.exporter.busy).toBe(false);
  });

  it('nothing extracted → error', async () => {
    const h = harness();
    h.exporter.start('pptx', settings(), 'x');
    h.feed({ type: 'export-started', format: 'pptx', total: 0 }, { type: 'export-extracted', meta: { title: 't' }, report: [] });
    expect(await h.settled()).toEqual({ type: 'error', message: 'No slides were extracted.' });
  });

  it('download failure → error event', async () => {
    const h = harness({
      download: () => {
        throw new Error('blocked');
      },
    });
    h.exporter.start('pptx', settings(), 'x');
    h.feed(...extractedMessages(loadFixture('tiny')));
    expect(await h.settled()).toEqual({ type: 'error', message: 'blocked' });
  });
});

describe('Exporter: IR JSON', () => {
  it('serializes the collected deck without touching images', async () => {
    const deck = loadFixture('kitchen-sink');
    const processAssets = vi.fn(async () => ({ ...STATS }));
    const h = harness({ processAssets });
    h.exporter.start('ir-json', settings(), '');
    h.feed(...extractedMessages(deck, EXTRACT_REPORT, 'ir-json'));
    const done = await h.settled();
    expect(done.type).toBe('done');
    expect(processAssets).not.toHaveBeenCalled();
    expect(h.downloads[0].fileName).toBe(`${deck.meta.title}.figmadeck.json`);
    expect(h.downloads[0].mime).toBe('application/json');
    const back = deserializeDeck(new TextDecoder().decode(h.downloads[0].data));
    expect(back.slides).toEqual(deck.slides);
    expect(back.assets.photo.data).toEqual(deck.assets.photo.data);
    expect(back.report).toEqual(EXTRACT_REPORT);
    expect(back.meta.author).toBe('Main Author');
  });
});

describe('Exporter: PDF', () => {
  const MISSING_FRAME: ReportEntry[] = [{ level: 'warning', code: 'missing-frame', slideId: '9:9', slideName: 'Old intro', message: 'Frame "Old intro" no longer exists and was skipped.' }];

  async function page(w: number, h: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([w, h]);
    return doc.save();
  }

  it('collects Figma PDF pages and merges them', async () => {
    const h = harness();
    h.exporter.start('pdf', settings(), 'Deck');
    h.feed(
      { type: 'export-started', format: 'pdf', total: 2 },
      { type: 'export-progress', phase: 'pdf', done: 0, total: 2, label: 'A' },
      { type: 'export-pdf-page', index: 1, total: 2, name: 'B', bytes: await page(200, 100) },
      { type: 'export-pdf-page', index: 0, total: 2, name: 'A', bytes: await page(100, 100) },
      { type: 'export-pdf-done', meta: { title: 'Deck' }, report: MISSING_FRAME },
    );
    const done = await h.settled();
    expect(done.type).toBe('done');
    if (done.type !== 'done') return;
    expect(done.outcome.entries).toEqual(MISSING_FRAME); // main's report reaches the report dialog
    expect(done.outcome.pdfDedupe).toEqual({ objects: expect.any(Number), bytes: expect.any(Number) });
    expect(h.downloads[0].fileName).toBe('Deck.pdf');
    expect(h.downloads[0].mime).toBe('application/pdf');
    const merged = await PDFDocument.load(h.downloads[0].data);
    expect(merged.getPages().map((p) => p.getWidth())).toEqual([100, 200]); // index order, not arrival order
    const phases = h.events.filter((e) => e.type === 'progress').map((e) => (e.type === 'progress' ? e.progress.phase : ''));
    expect(phases).toContain('pdf');
    expect(phases).toContain('merge');
  });

  it('no pages → error', async () => {
    const h = harness();
    h.exporter.start('pdf', settings(), 'Deck');
    h.feed({ type: 'export-started', format: 'pdf', total: 1 }, { type: 'export-pdf-done', meta: { title: 'Deck' }, report: [] });
    expect(await h.settled()).toEqual({ type: 'error', message: 'No pages were exported.' });
  });

  it('export-pdf-done from an older main (no report) still works', async () => {
    const h = harness();
    h.exporter.start('pdf', settings(), 'Deck');
    h.feed(
      { type: 'export-started', format: 'pdf', total: 1 },
      { type: 'export-pdf-page', index: 0, total: 1, name: 'A', bytes: await page(100, 100) },
      { type: 'export-pdf-done', meta: { title: 'Deck' } } as unknown as MainToUi,
    );
    const done = await h.settled();
    expect(done.type === 'done' && done.outcome.entries).toEqual([]);
  });

  it('image PDF renders the extracted deck', async () => {
    const deck = loadFixture('diploma');
    const processAssets = vi.fn(async () => ({ ...STATS }));
    const h = harness({ processAssets });
    h.exporter.start('pdf-image', settings({ compression: 'off', jpeg: false, jpegQuality: 0.7, rasterScale: 1 }), 'Diploma');
    const sent = h.sent[0];
    expect(sent.type === 'start-export' && [sent.settings.mode, sent.settings.jpeg, sent.settings.compression]).toEqual(['image', true, 'balanced']);
    h.feed(...extractedMessages(deck, [], 'pdf-image'));
    const done = await h.settled();
    expect(done.type).toBe('done');
    expect(h.downloads[0].fileName).toBe('Diploma.pdf');
    const doc = await PDFDocument.load(h.downloads[0].data);
    expect(doc.getPageCount()).toBe(deck.slides.length);
    // Baked JPEG pages at the JPEG quality of the settings.
    expect(processAssets).toHaveBeenCalledWith(expect.any(Object), { rasterScale: 1, compression: 'balanced', jpegQuality: 0.7, imageTarget: true }, expect.any(Object));
    // 1 px = 1 pt.
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual(deck.slides.map((sl) => [sl.width, sl.height]));
  });
});

describe('Exporter: cancel', () => {
  it('while main extracts: sends cancel-export, waits for confirmation', async () => {
    const h = harness();
    h.exporter.start('pptx', settings(), 'x');
    h.feed({ type: 'export-started', format: 'pptx', total: 3 });
    h.exporter.cancel();
    expect(h.sent.map((m) => m.type)).toEqual(['start-export', 'cancel-export']);
    const last = h.events[h.events.length - 1];
    expect(last.type === 'progress' && last.progress.cancelling).toBe(true);
    expect(h.exporter.busy).toBe(true);
    h.feed({ type: 'export-cancelled' });
    expect(await h.settled()).toEqual({ type: 'cancelled' });
    expect(h.exporter.busy).toBe(false);
    h.exporter.cancel(); // no-op now
    expect(h.sent).toHaveLength(2);
  });

  it('gives up waiting after the timeout', async () => {
    const h = harness();
    h.exporter.start('pptx', settings(), 'x');
    h.exporter.cancel();
    expect(h.timers).toHaveLength(1);
    h.timers[0]();
    expect(await h.settled()).toEqual({ type: 'cancelled' });
    expect(h.exporter.busy).toBe(false);
  });

  it('cancel crossing export-extracted: nothing is built', async () => {
    const build = vi.fn(buildPptx);
    const h = harness({ buildPptx: build });
    h.exporter.start('pptx', settings(), 'x');
    h.exporter.cancel();
    h.feed(...extractedMessages(loadFixture('tiny')));
    expect(await h.settled()).toEqual({ type: 'cancelled' });
    expect(build).not.toHaveBeenCalled();
    expect(h.downloads).toHaveLength(0);
  });

  it('export-error after cancel counts as cancelled', async () => {
    const h = harness();
    h.exporter.start('pptx', settings(), 'x');
    h.exporter.cancel();
    h.feed({ type: 'export-error', message: 'stopped' });
    expect(await h.settled()).toEqual({ type: 'cancelled' });
  });

  it('during UI-side work: stops at the next checkpoint, no cancel-export', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const build = vi.fn(buildPptx);
    const h = harness({
      buildPptx: build,
      processAssets: async (_assets, _o, hooks) => {
        await gate;
        if (hooks.isCancelled?.()) throw Object.assign(new Error('Image processing cancelled'), { name: 'ImagesCancelledError' });
        return { ...STATS };
      },
    });
    h.exporter.start('pptx', settings(), 'x');
    h.feed(...extractedMessages(loadFixture('kitchen-sink')));
    h.exporter.cancel();
    release();
    expect(await h.settled()).toEqual({ type: 'cancelled' });
    expect(h.sent.map((m) => m.type)).toEqual(['start-export']);
    expect(build).not.toHaveBeenCalled();
  });

  it('during image compression: the AbortSignal fires at once and the main-thread note is shown', async () => {
    const seen: { hooks: ProcessHooks | null } = { hooks: null };
    const h = harness({
      processAssets: (_assets, _o, hooks) =>
        new Promise((_resolve, reject) => {
          seen.hooks = hooks;
          hooks.onProgress?.(0, 2, { width: 1920, height: 1080, thread: 'main' });
          hooks.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Image compression cancelled'), { name: 'CompressCancelledError' })));
        }),
    });
    h.exporter.start('pptx', settings(), 'x');
    h.feed(...extractedMessages(loadFixture('kitchen-sink')));
    await vi.waitFor(() => expect(seen.hooks).not.toBeNull());
    const last = h.events.filter((e) => e.type === 'progress').pop();
    expect(last?.type === 'progress' && last.progress).toMatchObject({ phase: 'images', image: { width: 1920, height: 1080 }, mainThread: true });
    expect(seen.hooks!.signal!.aborted).toBe(false);
    h.exporter.cancel();
    expect(seen.hooks!.signal!.aborted).toBe(true);
    expect(await h.settled()).toEqual({ type: 'cancelled' });
    expect(h.sent.map((m) => m.type)).toEqual(['start-export']);
  });

  it('during the build: the progress callback aborts buildPptx', async () => {
    let exporter: Exporter | null = null;
    let progressCalls = 0;
    const h = harness({
      buildPptx: (deck, options, onProgress) => {
        exporter?.cancel(); // "Cancel" pressed while the builder runs
        return buildPptx(deck, options, (p) => {
          progressCalls++;
          onProgress?.(p);
        });
      },
    });
    exporter = h.exporter;
    h.exporter.start('pptx', settings(), 'x');
    h.feed(...extractedMessages(loadFixture('mixed-sizes')));
    expect(await h.settled()).toEqual({ type: 'cancelled' });
    expect(progressCalls).toBe(1); // aborted at the first checkpoint
    expect(h.downloads).toHaveLength(0);
  });
});

describe('Exporter: stray messages', () => {
  it('export messages without a run are consumed and ignored', () => {
    const h = harness();
    expect(h.exporter.handle({ type: 'export-started', format: 'pptx', total: 1 })).toBe(true);
    expect(h.exporter.handle({ type: 'export-cancelled' })).toBe(true);
    expect(h.exporter.handle({ type: 'export-error', message: 'x' })).toBe(true);
    expect(h.exporter.handle({ type: 'toast', message: 'x' })).toBe(false);
    expect(h.exporter.handle({ type: 'slides', slides: [] })).toBe(false);
    expect(h.events).toEqual([]);
  });

  it('main error → error event', async () => {
    const h = harness();
    h.exporter.start('pptx', settings(), 'x');
    h.feed({ type: 'export-error', message: 'No slides to export' });
    expect(await h.settled()).toEqual({ type: 'error', message: 'No slides to export' });
  });
});
