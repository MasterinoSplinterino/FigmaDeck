/**
 * Plugin controller (src/main.ts) against the mock `figma` global.
 * main.ts bootstraps on import, so every test imports a fresh module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readPngInfo } from '../../src/extract/png';
import type { ReportEntry, Slide } from '../../src/ir/types';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { FakeEnv, doc, frame, installFigmaGlobal, page, radial, rect, resetIds, section, text, vector, type MockNode } from '../helpers/figma-mocks';

beforeEach(() => resetIds());

async function boot(document: MockNode, opts: Parameters<typeof installFigmaGlobal>[2] = {}) {
  vi.resetModules();
  const env = new FakeEnv();
  const g = installFigmaGlobal(env, document, opts);
  await import('../../src/main');
  return { env, g };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fileWith(frames: MockNode[], deck: string[] = []) {
  const p = page({ id: 'p1', name: 'Page A', children: frames });
  const d = doc([p]);
  d.name = 'My file';
  if (deck.length) d.setPluginData('figmadeck.slides', JSON.stringify(deck));
  return { d, p };
}

describe('main: deck list', () => {
  it('ui-ready → init with slides (missing ones flagged), default title, settings, selection', async () => {
    const { d } = fileWith([frame({ id: 'f1', name: 'One', width: 800, height: 600 })], ['f1', 'gone']);
    const { g } = await boot(d);
    g.send({ type: 'ui-ready' });
    const init = await g.waitFor('init');
    expect(init).toMatchObject({
      deckTitle: 'My file',
      fileName: 'My file',
      settings: DEFAULT_SETTINGS,
      selection: { frameCount: 0, alreadyInDeck: 0 },
      slides: [
        { id: 'f1', name: 'One', width: 800, height: 600, pageId: 'p1', pageName: 'Page A' },
        { id: 'gone', missing: true },
      ],
    });
  });

  it('add-selection: sections expand, nested layers climb, duplicates skipped, canvas order', async () => {
    const nested = rect({ id: 'nested' });
    const f1 = frame({ id: 'f1', x: 0, y: 0 });
    const f4 = frame({ id: 'f4', x: 0, y: 1000, children: [frame({ id: 'inner', children: [nested] })] });
    const sec = section({ id: 'sec', children: [frame({ id: 'f2', x: 500, y: 0 }), frame({ id: 'f3', x: 200, y: 10 }), rect({ id: 'loose' })] });
    const { d, p } = fileWith([f1, f4, sec], ['f1']);
    const { g } = await boot(d);
    p.selection = [sec, nested, f1];
    g.handlers.get('selectionchange')!.forEach((h) => h());
    expect(g.posted.at(-1)).toEqual({ type: 'selection', selection: { frameCount: 4, alreadyInDeck: 1 } });
    g.send({ type: 'add-selection' });
    const slides = (await g.waitFor('slides')).slides as Array<{ id: string }>;
    expect(slides.map((s) => s.id)).toEqual(['f1', 'f3', 'f2', 'f4']);
    expect(JSON.parse(d.getPluginData('figmadeck.slides'))).toEqual(['f1', 'f3', 'f2', 'f4']);

    g.posted.length = 0;
    g.send({ type: 'add-selection' });
    await g.waitFor('toast');
    p.selection = [];
    g.posted.length = 0;
    g.send({ type: 'add-selection' });
    expect(await g.waitFor('toast')).toMatchObject({ error: true });
  });

  it('reorder (validated), remove, clear, sort, title', async () => {
    const { d } = fileWith([frame({ id: 'a', x: 0 }), frame({ id: 'b', x: 200 }), frame({ id: 'c', x: 400 })], ['c', 'a', 'b']);
    const { g } = await boot(d);
    const deck = () => JSON.parse(d.getPluginData('figmadeck.slides'));
    g.send({ type: 'reorder-slides', ids: ['a', 'a', 'b'] });
    await g.waitFor('slides');
    expect(deck()).toEqual(['c', 'a', 'b']);
    g.posted.length = 0;
    g.send({ type: 'reorder-slides', ids: ['b', 'c', 'a'] });
    await g.waitFor('slides');
    expect(deck()).toEqual(['b', 'c', 'a']);
    g.posted.length = 0;
    g.send({ type: 'sort-slides' });
    await g.waitFor('slides');
    expect(deck()).toEqual(['a', 'b', 'c']);
    g.posted.length = 0;
    g.send({ type: 'remove-slides', ids: ['b'] });
    await g.waitFor('slides');
    expect(deck()).toEqual(['a', 'c']);
    g.send({ type: 'set-deck-title', title: '  Q3 review ' });
    await tick();
    expect(d.getPluginData('figmadeck.title')).toBe('Q3 review');
    g.posted.length = 0;
    g.send({ type: 'clear-slides' });
    await g.waitFor('slides');
    expect(deck()).toEqual([]);
  });

  it('thumbnails, previews, focus, fonts, settings, resize, notify', async () => {
    const t1 = text({ fontName: { family: 'Inter', style: 'Regular' } });
    const t2 = text({ fontName: { family: 'SB Sans', style: 'Semibold' } });
    const hidden = text({ visible: false, fontName: { family: 'Ghost', style: 'Regular' } });
    const f = frame({ id: 'f', width: 640, height: 480, children: [t1, t2, hidden] });
    const other = page({ id: 'p2', name: 'Other', children: [frame({ id: 'g', width: 100, height: 50 })] });
    const p1 = page({ id: 'p1', children: [f] });
    const d = doc([p1, other]);
    d.setPluginData('figmadeck.slides', JSON.stringify(['f', 'g']));
    const { g } = await boot(d, { fonts: [{ family: 'Inter', style: 'Regular' }] });

    g.send({ type: 'request-thumbnails', ids: ['f', 'g'] });
    await tick(20);
    const thumbs = g.posted.filter((m) => m.type === 'thumbnail');
    expect(thumbs.map((m) => [m.id, readPngInfo(m.bytes as Uint8Array)?.width])).toEqual([
      ['f', 320],
      ['g', 320],
    ]);
    g.send({ type: 'request-preview', id: 'g' });
    const preview = await g.waitFor('preview');
    expect(readPngInfo(preview.bytes as Uint8Array)?.width).toBe(200); // min(1400, 100 × 2)

    g.send({ type: 'focus-slide', id: 'g' });
    await tick();
    expect((g.api.currentPage as MockNode).id).toBe('p2');
    expect((other.selection as MockNode[]).map((n) => n.id)).toEqual(['g']);
    expect(g.zoomedTo.at(-1)?.map((n) => n.id)).toEqual(['g']);

    g.send({ type: 'request-fonts' });
    const fonts = await g.waitFor('fonts');
    expect(fonts.fonts).toEqual([
      { family: 'Inter', style: 'Regular', count: 1, missing: false },
      { family: 'SB Sans', style: 'Semibold', count: 1, missing: true },
    ]);

    g.send({ type: 'save-settings', settings: { ...DEFAULT_SETTINGS, rasterScale: 7, mode: 'exact' } });
    await tick();
    expect(g.storage.get('figmadeck.settings')).toMatchObject({ rasterScale: 2, mode: 'exact' });

    g.send({ type: 'resize', width: 100, height: 5000 });
    g.send({ type: 'notify', message: 'hi', error: true });
    await tick();
    expect(g.resized).toEqual([[720, 5000]]);
    expect(g.notifications).toEqual([{ message: 'hi', error: true }]);
  });
});

describe('main: export', () => {
  it('pptx: streams slides with their new assets, then meta + report (missing frames warned)', async () => {
    const f1 = frame({ id: 'f1', name: 'One', width: 800, height: 600, children: [vector({ id: 'v' }), text({ id: 't' })] });
    const f2 = frame({ id: 'f2', name: 'Two', x: 1000, width: 800, height: 600, fills: [radial()], children: [rect()] });
    const { d } = fileWith([f1, f2], ['f1', 'gone', 'f2']);
    const { g, env } = await boot(d);
    g.send({ type: 'start-export', format: 'pptx', settings: { ...DEFAULT_SETTINGS, author: 'Ann', company: 'ACME' } });
    const extracted = await g.waitFor('export-extracted');
    const types = g.posted.map((m) => m.type).filter((t) => t.startsWith('export-') && t !== 'export-progress');
    expect(types).toEqual(['export-started', 'export-slide', 'export-slide', 'export-extracted']);
    expect(g.posted.find((m) => m.type === 'export-started')).toEqual({ type: 'export-started', format: 'pptx', total: 2 });
    const slides = g.posted.filter((m) => m.type === 'export-slide');
    expect(slides.map((m) => (m.slide as Slide).id)).toEqual(['f1', 'f2']);
    expect(slides.map((m) => (m.assets as unknown[]).length)).toEqual([2, 1]); // PNG + SVG, then the bg composite
    expect(extracted.meta).toMatchObject({ title: 'My file', author: 'Ann', company: 'ACME', sourceFile: 'My file' });
    expect(typeof (extracted.meta as { createdAt: string }).createdAt).toBe('string');
    const report = extracted.report as ReportEntry[];
    expect(report[0]).toMatchObject({ level: 'warning', code: 'missing-frame', slideId: 'gone' });
    expect(env.liveClones()).toEqual([]);
    expect(g.posted.some((m) => m.type === 'export-progress')).toBe(true);
  });

  it('pdf: one page per frame, then done', async () => {
    const { d } = fileWith([frame({ id: 'f1', name: 'One' }), frame({ id: 'f2', name: 'Two', x: 200 })], ['f1', 'f2']);
    const { g } = await boot(d);
    g.send({ type: 'start-export', format: 'pdf', settings: DEFAULT_SETTINGS });
    await g.waitFor('export-pdf-done');
    const pages = g.posted.filter((m) => m.type === 'export-pdf-page');
    expect(pages.map((m) => [m.index, m.total, m.name])).toEqual([
      [0, 2, 'One'],
      [1, 2, 'Two'],
    ]);
  });

  it('cancel-export stops at the next yield and cleans up', async () => {
    const kids = Array.from({ length: 300 }, (_, i) => vector({ x: (i % 30) * 20, y: Math.floor(i / 30) * 20, width: 10, height: 10 }));
    const { d } = fileWith([frame({ id: 'f1', width: 800, height: 600, fills: [radial()], children: kids })], ['f1']);
    const { g, env } = await boot(d);
    g.send({ type: 'start-export', format: 'pptx', settings: DEFAULT_SETTINGS });
    g.send({ type: 'cancel-export' });
    await g.waitFor('export-cancelled');
    expect(g.posted.some((m) => m.type === 'export-extracted')).toBe(false);
    expect(env.liveClones()).toEqual([]);
  });

  it('errors are reported, not thrown', async () => {
    const { d } = fileWith([], []);
    const { g } = await boot(d);
    g.send({ type: 'start-export', format: 'pptx', settings: DEFAULT_SETTINGS });
    expect(await g.waitFor('export-error')).toMatchObject({ message: expect.stringContaining('No slides') });
  });

  it('a second export while one is running is refused', async () => {
    const kids = Array.from({ length: 100 }, (_, i) => vector({ x: i * 5, width: 4, height: 4 }));
    const { d } = fileWith([frame({ id: 'f1', width: 800, height: 600, children: kids })], ['f1']);
    const { g } = await boot(d);
    g.send({ type: 'start-export', format: 'pptx', settings: DEFAULT_SETTINGS });
    g.send({ type: 'start-export', format: 'pdf', settings: DEFAULT_SETTINGS });
    expect(await g.waitFor('toast')).toMatchObject({ message: expect.stringContaining('already running'), error: true });
    await g.waitFor('export-extracted');
    expect(g.posted.filter((m) => m.type === 'export-started')).toHaveLength(1);
  });
});
