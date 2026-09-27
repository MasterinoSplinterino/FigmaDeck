/**
 * main.ts: deck-mutating messages are handled one after another (a sort that awaits node lookups must
 * not overwrite an add / remove that arrived meanwhile), while exports and `cancel-export` stay
 * immediate. Leftover temporary nodes are removed from the current page and the deck frames' pages.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { CONFIG } from '../../src/config';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { FakeEnv, MockNode, doc, frame, installFigmaGlobal, page, radial, rect, resetIds, vector } from '../helpers/figma-mocks';

beforeEach(() => resetIds());

async function boot(document: MockNode) {
  vi.resetModules();
  const env = new FakeEnv();
  const g = installFigmaGlobal(env, document);
  await import('../../src/main');
  return { env, g };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const deckOf = (d: MockNode) => JSON.parse(d.getPluginData('figmadeck.slides')) as string[];
const temp = (id: string) => {
  const n = rect({ id });
  n.setPluginData(CONFIG.extract.tempPluginDataKey, '1');
  return n;
};

it('a slide added while "sort by canvas" is resolving nodes survives', async () => {
  const p = page({ id: 'p1', children: [frame({ id: 'a', x: 400 }), frame({ id: 'b', x: 0 }), frame({ id: 'c', x: 800 })] });
  const d = doc([p]);
  d.setPluginData('figmadeck.slides', JSON.stringify(['a', 'b']));
  const { g } = await boot(d);
  p.selection = [p.children![2]]; // frame 'c'
  g.send({ type: 'sort-slides' });
  g.send({ type: 'add-selection' });
  await tick();
  expect(deckOf(d)).toEqual(['b', 'a', 'c']);
});

it('a slide removed while "sort by canvas" is resolving nodes stays removed', async () => {
  const p = page({ id: 'p1', children: [frame({ id: 'a', x: 400 }), frame({ id: 'b', x: 0 })] });
  const d = doc([p]);
  d.setPluginData('figmadeck.slides', JSON.stringify(['a', 'b']));
  const { g } = await boot(d);
  g.send({ type: 'sort-slides' });
  g.send({ type: 'remove-slides', ids: ['a'] });
  await tick();
  expect(deckOf(d)).toEqual(['b']);
  // The last 'slides' message reflects the final deck.
  const last = g.posted.filter((m) => m.type === 'slides').at(-1)!;
  expect((last.slides as Array<{ id: string }>).map((s) => s.id)).toEqual(['b']);
});

it('a failing deck handler does not block the following ones', async () => {
  const p = page({ id: 'p1', children: [frame({ id: 'a', x: 400 }), frame({ id: 'b', x: 0 })] });
  const d = doc([p]);
  d.setPluginData('figmadeck.slides', JSON.stringify(['a', 'b']));
  const { g } = await boot(d);
  const original = d.setPluginData.bind(d);
  let fail = true;
  d.setPluginData = (k: string, v: string) => {
    if (fail) {
      fail = false;
      throw new Error('storage full');
    }
    original(k, v);
  };
  g.send({ type: 'sort-slides' });
  g.send({ type: 'remove-slides', ids: ['b'] });
  await tick();
  expect(g.posted.some((m) => m.type === 'toast' && m.error === true && String(m.message).includes('storage full'))).toBe(true);
  expect(deckOf(d)).toEqual(['a']);
});

it('deck edits and cancel-export are not queued behind a running export', async () => {
  const kids = Array.from({ length: 300 }, (_, i) => vector({ x: (i % 30) * 20, y: Math.floor(i / 30) * 20, width: 10, height: 10 }));
  const p = page({ id: 'p1', children: [frame({ id: 'f1', width: 800, height: 600, fills: [radial()], children: kids }), frame({ id: 'f2', x: 1000 })] });
  const d = doc([p]);
  d.setPluginData('figmadeck.slides', JSON.stringify(['f1', 'f2']));
  const { g, env } = await boot(d);
  let sent = false;
  env.onExport = () => {
    if (sent) return;
    sent = true; // the export is running now
    g.send({ type: 'remove-slides', ids: ['f2'] });
    g.send({ type: 'cancel-export' });
  };
  g.send({ type: 'start-export', format: 'pptx', settings: DEFAULT_SETTINGS });
  await g.waitFor('export-cancelled');
  await tick();
  expect(deckOf(d)).toEqual(['f1']);
  expect(g.posted.some((m) => m.type === 'export-extracted')).toBe(false);
  expect(env.liveClones()).toEqual([]);
});

it('leftover temporary nodes are removed from the current page and the deck pages, nothing else', async () => {
  const f1 = frame({ id: 'f1', children: [rect({ id: 'keep1' })] });
  const f2 = frame({ id: 'f2', children: [rect({ id: 'keep2' })] });
  const p1 = page({ id: 'p1', children: [f1, temp('left1')] });
  const p2 = page({ id: 'p2', children: [f2, temp('left2')] });
  const p3 = page({ id: 'p3', children: [temp('elsewhere')] });
  const d = doc([p1, p2, p3]);
  d.setPluginData('figmadeck.slides', JSON.stringify(['f2']));
  await boot(d);
  await tick();
  expect(p1.children!.map((n) => n.id)).toEqual(['f1']);
  expect(p2.children!.map((n) => n.id)).toEqual(['f2']);
  expect(p3.children!.map((n) => n.id)).toEqual(['elsewhere']); // not a deck page: left alone
  expect(f1.children!.map((n) => n.id)).toEqual(['keep1']);
});

it('the deferred start-up scan never removes the temporary nodes of an export that is already running', async () => {
  vi.resetModules();
  const f = frame({ id: 'f', width: 400, height: 300, fills: [radial()], children: [rect({ id: 'r' })] });
  const p1 = page({ id: 'p1', children: [f] });
  const d = doc([p1]);
  d.setPluginData('figmadeck.slides', JSON.stringify(['f']));
  const env = new FakeEnv();
  const g = installFigmaGlobal(env, d);
  // The start-up scan's node lookup is slow; the export's own lookups are not.
  const lookup = g.api.getNodeByIdAsync as (id: string) => Promise<unknown>;
  let first = true;
  g.api.getNodeByIdAsync = async (id: string) => {
    if (first) {
      first = false;
      await tick(30);
    }
    return lookup(id);
  };
  // Exports take a while, so the start-up scan resumes while the composite clone is alive.
  const exportAsync = env.exportAsync.bind(env);
  const removedDuringExport: boolean[] = [];
  env.exportAsync = async (node, settings) => {
    await tick(60);
    removedDuringExport.push((node as unknown as MockNode).removed);
    return exportAsync(node, settings);
  };
  await import('../../src/main');
  g.send({ type: 'start-export', format: 'pptx', settings: DEFAULT_SETTINGS });
  await g.waitFor('export-extracted');
  expect(removedDuringExport).toEqual([false]);
  const slide = g.posted.find((m) => m.type === 'export-slide')!.slide as { elements: Array<{ id: string }> };
  expect(slide.elements.map((e) => e.id)).toEqual(['~bg:f', 'r']);
  expect(env.liveClones()).toEqual([]);
});

it('a deck page that is not loaded is skipped at start-up and cleaned when an export loads it', async () => {
  const f2 = frame({ id: 'f2', width: 200, height: 100, children: [rect({ id: 'r' })] });
  const p1 = page({ id: 'p1' });
  const p2 = page({ id: 'p2', children: [f2, temp('left2')] });
  // dynamic-page: searching a page that is not loaded throws.
  p2.findAllWithCriteria = function (this: MockNode, criteria: Parameters<MockNode['findAllWithCriteria']>[0]) {
    if (!this.loaded) throw new Error('Call page.loadAsync() first');
    return MockNode.prototype.findAllWithCriteria.call(this, criteria);
  };
  const d = doc([p1, p2]);
  d.setPluginData('figmadeck.slides', JSON.stringify(['f2']));
  const { g } = await boot(d);
  await tick();
  expect(p2.children!.map((n) => n.id)).toEqual(['f2', 'left2']);
  g.send({ type: 'start-export', format: 'pptx', settings: DEFAULT_SETTINGS });
  await g.waitFor('export-extracted');
  expect(p2.children!.map((n) => n.id)).toEqual(['f2']);
});
