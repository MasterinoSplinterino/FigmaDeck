import { describe, expect, it } from 'vitest';
import { AssetStore } from '../../src/extract/assets';
import { exportComposite, exportPicture, exportScale, remapPaths, TempNodes, wantsSvg } from '../../src/extract/raster';
import {
  countFonts,
  framesFromSelection,
  isPermutation,
  parseSlideIds,
  serializeSlideIds,
  sortNodesByCanvas,
  topLevelFrameOf,
} from '../../src/extract/selection';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { FakeEnv, component, doc, frame, group, instance, onPage, page, rect, scene, section, solid, text, type MockNode } from '../helpers/figma-mocks';

const ctxOf = (env: FakeEnv) => ({ env, settings: DEFAULT_SETTINGS, assets: new AssetStore(), temp: new TempNodes(env) });
const origin = (n: MockNode): string => (n.clonedFrom ? origin(n.clonedFrom as MockNode) : n.id);

describe('raster helpers', () => {
  it('export scale is clamped to the max side', () => {
    expect(exportScale(2, { x: 0, y: 0, w: 100, h: 50 })).toBe(2);
    expect(exportScale(3, { x: 0, y: 0, w: 5000, h: 50 }, 8192)).toBeCloseTo(1.6384);
  });

  it('SVG only for pure vector reasons', () => {
    expect(wantsSvg(['vector'])).toBe(true);
    expect(wantsSvg(['vector', 'boolean-operation'])).toBe(true);
    expect(wantsSvg(['vector', 'blur'])).toBe(false);
    expect(wantsSvg([])).toBe(false);
  });

  it('remaps kept paths after pruning', () => {
    expect(remapPaths([[3, 1]], [3, 1])).toEqual([0, 0]);
    expect(remapPaths([[2], [5]], [5])).toEqual([1]);
    expect(remapPaths([[3]], [3, 1, 0])).toEqual([0, 1, 0]); // below a fully kept subtree indices stay
    expect(remapPaths([[1, 4], [1, 2]], [1, 4])).toEqual([0, 1]);
  });

  it('exportPicture: PNG asset with header size, alpha and display size', async () => {
    const env = new FakeEnv();
    const ctx = ctxOf(env);
    const r = rect({ x: 10, y: 10, width: 30, height: 20 });
    onPage(r);
    const pic = await exportPicture(ctx, scene(r), { role: 'raster' });
    expect(pic).toEqual({ assetId: 'ras1', svgAssetId: null, region: { x: 10, y: 10, w: 30, h: 20 } });
    expect(ctx.assets.get('ras1')).toMatchObject({ width: 60, height: 40, hasAlpha: true, displayWidth: 30, displayHeight: 20 });
    expect(await exportPicture(ctx, scene(rect({ renderBounds: null })), { role: 'raster' })).toBeNull();
  });

  it('drops an SVG whose size disagrees with the PNG region', async () => {
    const env = new FakeEnv();
    const ctx = ctxOf(env);
    const r = rect({ width: 30, height: 20 });
    onPage(r);
    const orig = env.exportAsync.bind(env);
    env.exportAsync = async (n, s) => (s.format === 'SVG' ? new TextEncoder().encode('<svg width="99" height="20">') : orig(n, s));
    expect((await exportPicture(ctx, scene(r), { role: 'vector-fallback', svg: true }))?.svgAssetId).toBeNull();
  });

  it('composite: prunes to the kept branch, strips the ancestor, leaves the document untouched', async () => {
    const env = new FakeEnv();
    const ctx = ctxOf(env);
    const target = rect({ id: 'target', x: 10 });
    const card = frame({
      id: 'card',
      width: 200,
      height: 100,
      fills: [solid('#ffffff')],
      layoutMode: 'HORIZONTAL',
      children: [rect({ id: 'sibling' }), group({ id: 'g', children: [text({ id: 'x' }), target] })],
    });
    const p = onPage(card);
    const result = await exportComposite(ctx, { ancestor: scene(card), keep: [[1, 1]], stripAncestor: true }, 'raster');
    expect(result).toMatchObject({ assetId: 'ras1', hidden: [] });
    const exported = env.exports[0].node;
    expect(exported.layoutMode).toBe('NONE');
    expect(exported.fills).toEqual([]);
    expect(exported.children!.map(origin)).toEqual(['g']);
    expect(exported.children![0].children!.map(origin)).toEqual(['target']);
    expect(exported.removed).toBe(true);
    expect(p.children!.map((n) => n.id)).toEqual(['card']);
    expect(card.children!.length).toBe(2);
    expect(card.layoutMode).toBe('HORIZONTAL');
    expect(ctx.temp.count).toBe(0);
  });

  it('composite: own paint of a target (children removed, stroke kept only) and text hiding', async () => {
    const env = new FakeEnv();
    const ctx = ctxOf(env);
    const inst = instance({ id: 'i', fills: [solid('#ff0000')], strokes: [solid('#000000')], effects: [], children: [rect(), text()] });
    onPage(inst);
    await exportComposite(ctx, { ancestor: scene(inst), keep: [], target: { path: [], removeChildren: true, keep: { fills: false, strokes: true, effects: false } } }, 'raster');
    const exported = env.exports[0].node;
    expect(exported.type).toBe('FRAME'); // detached
    expect(exported.children).toEqual([]);
    expect(exported.fills).toEqual([]);
    expect(exported.strokes).toHaveLength(1);

    const root = frame({ id: 'root', children: [group({ children: [text({ id: 't1' }), rect()] }), text({ id: 't2' })] });
    onPage(root);
    const r = await exportComposite(ctx, { ancestor: scene(root), keep: null, hide: [[0, 0], [1], [0, 1]], useAbsoluteBounds: true }, 'background');
    expect(r?.hidden).toEqual([true, true, false]);
    const clone = env.exports[1].node;
    expect(clone.children![0].children![0].opacity).toBe(0);
    expect(clone.children![1].opacity).toBe(0);
    expect(root.children![1].opacity).toBe(1);
  });

  it('composite: temporary node removed when the export throws', async () => {
    const env = new FakeEnv();
    env.failExport = () => true;
    const ctx = ctxOf(env);
    const f = frame({ children: [rect()] });
    onPage(f);
    await expect(exportComposite(ctx, { ancestor: scene(f), keep: [] }, 'raster')).rejects.toThrow('export failed');
    expect(env.liveClones()).toEqual([]);
    expect(ctx.temp.count).toBe(0);
  });

  it('TempNodes marks and removes everything', () => {
    const env = new FakeEnv();
    const temp = new TempNodes(env);
    const p = page();
    const a = frame();
    const b = frame();
    p.appendChild(a);
    p.appendChild(b);
    temp.track(scene(a));
    temp.track(scene(b));
    expect(a.name).toBe('[FigmaDeck temp]');
    expect(a.getPluginData('figmadeck.temp')).toBe('1');
    temp.removeAll();
    expect(p.children).toEqual([]);
    expect(temp.count).toBe(0);
  });
});

describe('selection helpers', () => {
  it('top-level frames: pages, sections, component sets', () => {
    const deep = rect();
    const f = frame({ id: 'f', children: [group({ children: [deep] })] });
    const variant = component({ id: 'variant', children: [rect({ id: 'vr' })] });
    const set = frame({ id: 'set', children: [variant] });
    set.type = 'COMPONENT_SET';
    const sec = section({ id: 'sec', children: [frame({ id: 'inSec' })] });
    onPage(f, set, sec);
    expect(topLevelFrameOf(scene(deep))?.id).toBe('f');
    expect(topLevelFrameOf(scene(variant.children![0]))?.id).toBe('variant');
    expect(topLevelFrameOf(scene(sec.children![0]))?.id).toBe('inSec');
    const loose = rect({ id: 'loose' });
    onPage(loose);
    expect(topLevelFrameOf(scene(loose))).toBeNull();
    const grouped = group({ children: [frame({ id: 'inGroup' })] });
    onPage(grouped);
    expect(topLevelFrameOf(scene(grouped.children![0]))).toBeNull();
  });

  it('framesFromSelection expands sections, dedupes, keeps selection order', () => {
    const a = frame({ id: 'a' });
    const b = frame({ id: 'b', children: [rect({ id: 'inB' })] });
    const sec = section({ id: 's', children: [frame({ id: 'c' }), rect(), instance({ id: 'd' })] });
    onPage(a, b, sec);
    const sel = [b.children![0], sec, a, b].map((n) => scene(n));
    expect(framesFromSelection(sel).map((n) => n.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('deck persistence and reorder validation', () => {
    expect(parseSlideIds(serializeSlideIds(['1:2', '3:4']))).toEqual(['1:2', '3:4']);
    expect(parseSlideIds('garbage')).toEqual([]);
    expect(parseSlideIds('{"a":1}')).toEqual([]);
    expect(parseSlideIds('["a", 3, "a", ""]')).toEqual(['a']);
    expect(parseSlideIds(undefined)).toEqual([]);
    expect(isPermutation(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(isPermutation(['a', 'b'], ['a', 'a'])).toBe(false);
    expect(isPermutation(['a', 'b'], ['a'])).toBe(false);
    expect(isPermutation(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('canvas sort across pages', () => {
    const p1 = page({ children: [frame({ id: 'x2', x: 500 }), frame({ id: 'x1', x: 0 })] });
    const p2 = page({ children: [frame({ id: 'y1' })] });
    doc([p1, p2]);
    const all = [...p2.children!, ...p1.children!].map((n) => scene(n));
    expect(sortNodesByCanvas(all, [p1, p2].map((p) => scene<PageNode>(p))).map((n) => n.id)).toEqual(['x1', 'x2', 'y1']);
  });

  it('counts fonts per text segment', () => {
    const t1 = text({ segments: [{ characters: 'a', fontName: { family: 'Inter', style: 'Bold' } }, { characters: 'b' }] });
    const t2 = text({ characters: 'c' });
    const empty = text({ characters: '', segments: [] });
    expect(countFonts([t1, t2, empty].map((t) => scene<TextNode>(t)))).toEqual([
      { family: 'Inter', style: 'Bold', count: 1 },
      { family: 'Inter', style: 'Regular', count: 2 },
    ]);
  });
});
