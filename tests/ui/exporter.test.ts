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
import type { ProcessHooks } from '../../src/ui/images';
import { PPTX_MIME } from '../../src/ui/options';
import { imageDeckToPdf, mergePdfs } from '../../src/ui/pdf';
import type { ImageStats } from '../../src/ui/report';
import { loadFixture } from '../fixtures/load';

beforeAll(() => setLang('en'));

const noYield = () => Promise.resolve();
const STATS: ImageStats = { examined: 0, downscaled: 0, jpeg: 0, bytesBefore: 0, bytesAfter: 0 };

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
      hooks.onProgress?.(0, n);
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
    expect(processAssets).toHaveBeenCalledWith(expect.any(Object), { rasterScale: 3, jpeg: true, jpegQuality: DEFAULT_SETTINGS.jpegQuality }, expect.any(Object));
    expect(h.exporter.busy).toBe(false);

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
      { type: 'export-pdf-done', meta: { title: 'Deck' } },
    );
    const done = await h.settled();
    expect(done.type).toBe('done');
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
    h.feed({ type: 'export-started', format: 'pdf', total: 1 }, { type: 'export-pdf-done', meta: { title: 'Deck' } });
    expect(await h.settled()).toEqual({ type: 'error', message: 'No pages were exported.' });
  });

  it('image PDF renders the extracted deck', async () => {
    const deck = loadFixture('diploma');
    const h = harness();
    h.exporter.start('pdf-image', settings(), 'Diploma');
    h.feed(...extractedMessages(deck, [], 'pdf-image'));
    const done = await h.settled();
    expect(done.type).toBe('done');
    expect(h.downloads[0].fileName).toBe('Diploma.pdf');
    const doc = await PDFDocument.load(h.downloads[0].data);
    expect(doc.getPageCount()).toBe(deck.slides.length);
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
