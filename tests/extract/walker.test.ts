import { beforeEach, describe, expect, it } from 'vitest';
import { extractDeck, type ExtractDeckOptions } from '../../src/extract';
import type { Element, GroupElement, ImageElement, ShapeElement, TextElement } from '../../src/ir/types';
import { DEFAULT_SETTINGS, type ExportSettings } from '../../src/shared/settings';
import {
  FakeEnv,
  JPEG_BYTES,
  WEBP_BYTES,
  dropShadow,
  ellipse,
  frame,
  group,
  imagePaint,
  instance,
  line,
  linear,
  makePng,
  onPage,
  other,
  placement,
  radial,
  rect,
  resetIds,
  scene,
  solid,
  text,
  vector,
  type MockNode,
} from '../helpers/figma-mocks';

beforeEach(() => resetIds());

async function run(root: MockNode, settings: Partial<ExportSettings> = {}, env = new FakeEnv(), extra: Partial<ExtractDeckOptions> = {}) {
  if (!root.parent) onPage(root);
  const result = await extractDeck([scene(root)], { settings: { ...DEFAULT_SETTINGS, ...settings }, env, ...extra });
  expect(env.liveClones()).toEqual([]); // no temporary node survives
  return { result, slide: result.slides[0], env, report: result.report };
}

const ids = (els: Element[]) => els.map((e) => e.id);
const byId = <T extends Element>(els: Element[], id: string) => els.find((e) => e.id === id) as T;

describe('editable mode: basics', () => {
  it('maps a simple slide: background, native shapes, text, line, order and coordinates', async () => {
    const root = frame({
      id: 'root',
      name: 'Slide',
      x: 1000,
      y: 2000,
      width: 800,
      height: 600,
      fills: [solid('#ffffff')],
      children: [
        rect({ id: 'r', x: 10, y: 20, width: 100, height: 50, cornerRadius: 8, opacity: 0.5 }),
        ellipse({ id: 'e', x: 200, y: 20, width: 40, height: 40 }),
        text({ id: 't', x: 300, y: 30, width: 200, height: 24, characters: 'Привет' }),
        line({ id: 'l', x: 0, y: 500, width: 800, strokeCap: 'ROUND' }),
      ],
    });
    const { slide, env, report } = await run(root);
    expect(slide).toMatchObject({ id: 'root', name: 'Slide', width: 800, height: 600 });
    expect(slide.background).toEqual({ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } });
    expect(ids(slide.elements)).toEqual(['r', 'e', 't', 'l']);
    expect(byId<ShapeElement>(slide.elements, 'r')).toEqual({
      type: 'shape',
      id: 'r',
      name: 'rectangle r',
      transform: { x: 10, y: 20, w: 100, h: 50, rotation: 0, flipH: false, flipV: false },
      opacity: 0.5,
      shadow: null,
      geometry: 'roundRect',
      cornerRadius: 8,
      fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } },
      stroke: null,
    });
    expect(byId<ShapeElement>(slide.elements, 'e').geometry).toBe('ellipse');
    const t = byId<TextElement>(slide.elements, 't');
    expect(t.type).toBe('text');
    expect(t.transform).toMatchObject({ x: 300, y: 30, w: 200, h: 24 });
    expect(t.paragraphs[0].runs[0].text).toBe('Привет');
    const l = byId<ShapeElement>(slide.elements, 'l');
    expect(l).toMatchObject({ geometry: 'line', fill: null, stroke: { cap: 'round', weight: 2 } });
    expect(l.transform).toMatchObject({ x: 0, y: 500, w: 800, h: 0 });
    expect(env.exports).toHaveLength(0);
    expect(report).toEqual([]);
  });

  it('skips invisible, transparent and SLICE layers; rasterizes unsupported types', async () => {
    const root = frame({
      id: 'root',
      width: 400,
      height: 300,
      children: [
        rect({ id: 'hidden', visible: false }),
        rect({ id: 'transparent', opacity: 0 }),
        other('SLICE', { id: 'slice' }),
        other('STICKY', { id: 'sticky', x: 10, y: 10, width: 50, height: 50 }),
        other('TEXT_PATH', { id: 'tp', x: 100, y: 10, width: 50, height: 50 }),
        rect({ id: 'nofill', fills: [] }),
      ],
    });
    const { slide, report } = await run(root);
    expect(ids(slide.elements)).toEqual(['sticky', 'tp']);
    expect((slide.elements[0] as ImageElement).rasterized?.reasons).toEqual(['unsupported-node']);
    expect((slide.elements[1] as ImageElement).rasterized?.reasons).toEqual(['text-feature']);
    expect(report.map((r) => [r.level, r.code, r.nodeId])).toEqual([
      ['raster', 'rasterized', 'sticky'],
      ['raster', 'rasterized', 'tp'],
    ]);
  });

  it('effective opacity multiplies ancestors; rasters bake their own opacity', async () => {
    const root = frame({
      width: 400,
      height: 300,
      opacity: 0.8,
      // Wider than CONFIG.raster.iconMaxSize so the group is not treated as an icon.
      children: [group({ id: 'g', width: 600, opacity: 0.5, children: [rect({ id: 'r', opacity: 0.5 }), vector({ id: 'v', x: 150, opacity: 0.5 })] })],
    });
    const { slide } = await run(root, { preserveGroups: false });
    expect(byId(slide.elements, 'r').opacity).toBe(0.2);
    expect(byId(slide.elements, 'v').opacity).toBe(0.4);
  });

  it('root without a plain background: gradient → first shape, radial → own-paint composite', async () => {
    const g = await run(frame({ id: 'root', width: 200, height: 100, fills: [linear()], children: [rect({ id: 'r' })] }));
    expect(g.slide.background).toBeNull();
    expect(ids(g.slide.elements)).toEqual(['~bg:root', 'r']);
    expect((g.slide.elements[0] as ShapeElement).fill?.type).toBe('linear-gradient');

    const rad = await run(frame({ id: 'root', width: 200, height: 100, fills: [radial()], children: [rect({ id: 'r' })] }));
    expect(ids(rad.slide.elements)).toEqual(['~bg:root', 'r']);
    const bg = rad.slide.elements[0] as ImageElement;
    expect(bg.rasterized?.reasons).toEqual(['gradient']);
    expect(bg.transform).toMatchObject({ x: 0, y: 0, w: 200, h: 100 });
    const exported = rad.env.exports[0].node;
    expect(exported.clonedFrom).toBeDefined();
    expect(exported.children).toEqual([]); // children removed: own paint only
  });

  it('root stroke goes above the children of a clipping frame, below otherwise; root effects ignored', async () => {
    const clip = await run(frame({ id: 'root', width: 200, height: 100, strokes: [solid('#000000')], effects: [dropShadow(), dropShadow()], children: [rect({ id: 'r' })] }));
    expect(ids(clip.slide.elements)).toEqual(['r', '~stroke:root']);
    const s = clip.slide.elements[1] as ShapeElement;
    expect(s).toMatchObject({ fill: null, stroke: { weight: 1 } });
    const open = await run(frame({ id: 'root', clipsContent: false, width: 200, height: 100, strokes: [solid('#000000')], children: [rect({ id: 'r' })] }));
    expect(ids(open.slide.elements)).toEqual(['~stroke:root', 'r']);
  });
});

describe('editable mode: containers', () => {
  it('frames → group [background, children, stroke] (clipping) and merged fill+stroke (not clipping)', async () => {
    const card = (clipsContent: boolean) =>
      frame({
        id: 'card',
        x: 10,
        y: 10,
        width: 200,
        height: 100,
        clipsContent,
        fills: [solid('#eeeeee')],
        strokes: [solid('#000000')],
        effects: [dropShadow()],
        children: [rect({ id: 'a', width: 20, height: 20 }), text({ id: 't', x: 30 })],
      });
    const clipped = await run(frame({ width: 800, height: 600, children: [card(true)] }));
    const g = clipped.slide.elements[0] as GroupElement;
    expect(g.type).toBe('group');
    expect(ids(g.children)).toEqual(['~bg:card', 'a', 't', '~stroke:card']);
    const bg = g.children[0] as ShapeElement;
    expect(bg).toMatchObject({ fill: { type: 'solid' }, stroke: null, shadow: { type: 'outer' } });
    expect(bg.transform).toMatchObject({ x: 10, y: 10, w: 200, h: 100 });
    expect(g.transform).toMatchObject({ x: 10, y: 10, w: 200, h: 100, rotation: 0 });

    const open = await run(frame({ width: 800, height: 600, children: [card(false)] }));
    const g2 = open.slide.elements[0] as GroupElement;
    expect(ids(g2.children)).toEqual(['~bg:card', 'a', 't']);
    expect((g2.children[0] as ShapeElement).stroke).not.toBeNull();
  });

  it('preserveGroups off splices; a single emitted child is spliced', async () => {
    const root = frame({
      width: 800,
      height: 600,
      children: [group({ id: 'g1', children: [rect({ id: 'a' }), rect({ id: 'b', x: 200 })] }), group({ id: 'g2', children: [rect({ id: 'c' })] })],
    });
    expect(ids((await run(root)).slide.elements)).toEqual(['g1', 'c']);
    resetIds();
    const flat = await run(
      frame({ width: 800, height: 600, children: [group({ id: 'g1', children: [rect({ id: 'a' }), rect({ id: 'b', x: 200 })] })] }),
      { preserveGroups: false },
    );
    expect(ids(flat.slide.elements)).toEqual(['a', 'b']);
  });

  it('group opacity over overlapping children → one raster; separate children keep native', async () => {
    const overlapping = await run(
      frame({ width: 800, height: 600, children: [group({ id: 'g', opacity: 0.5, children: [rect({ id: 'a' }), rect({ id: 'b', x: 50 })] })] }),
    );
    expect(overlapping.slide.elements).toHaveLength(1);
    expect(overlapping.slide.elements[0]).toMatchObject({ type: 'image', id: 'g', opacity: 1, rasterized: { reasons: ['group-opacity'] } });
    const apart = await run(frame({ width: 800, height: 600, children: [group({ id: 'g', opacity: 0.5, children: [rect({ id: 'a' }), rect({ id: 'b', x: 300 })] })] }));
    const g = apart.slide.elements[0] as GroupElement;
    expect(g.children.map((c) => c.opacity)).toEqual([0.5, 0.5]);
  });

  it('masks / blend modes in groups rasterize the group', async () => {
    const { slide, report } = await run(
      frame({
        width: 800,
        height: 600,
        children: [
          group({ id: 'm', children: [ellipse({ isMask: true }), rect()] }),
          group({ id: 'b', x: 300, blendMode: 'MULTIPLY', children: [rect({ x: 300 })] }),
        ],
      }),
    );
    expect(slide.elements.map((e) => [e.id, e.type, (e as ImageElement).rasterized?.reasons])).toEqual([
      ['m', 'image', ['mask']],
      ['b', 'image', ['blend-mode']],
    ]);
    expect(report.map((r) => r.reasons)).toEqual([['mask'], ['blend-mode']]);
  });

  it('a mask on the slide root becomes a composite of the masked range only', async () => {
    const root = frame({
      id: 'root',
      width: 800,
      height: 600,
      children: [
        text({ id: 'title' }),
        ellipse({ id: 'mask', name: 'Mask', isMask: true, x: 100, y: 100 }),
        rect({ id: 'photo', x: 100, y: 100 }),
        rect({ id: 'mask2', isMask: true, x: 400, y: 100 }),
        rect({ id: 'p2', x: 400, y: 100 }),
        text({ id: 'caption', visible: false }),
      ],
    });
    const { slide, env } = await run(root);
    expect(ids(slide.elements)).toEqual(['title', '~mask:mask', '~mask:mask2']);
    const kept = env.exports.map((e) => (e.node.children ?? []).map((c) => (c.clonedFrom as MockNode).id));
    expect(kept).toEqual([
      ['mask', 'photo'],
      ['mask2', 'p2'],
    ]);
    expect(env.exports[0].node.fills).toEqual([]); // the root clone only provides the clip
    expect((slide.elements[1] as ImageElement).rasterized?.reasons).toEqual(['mask']);
  });

  it('icon-like groups export once (SVG + PNG)', async () => {
    const { slide, env, result } = await run(
      frame({ width: 800, height: 600, children: [group({ id: 'icon', width: 24, height: 24, children: [vector({ width: 24, height: 24 }), vector({ width: 12, height: 12 })] })] }),
    );
    expect(slide.elements).toHaveLength(1);
    const pic = slide.elements[0] as ImageElement;
    expect(pic).toMatchObject({ id: 'icon', rasterized: { reasons: ['vector'] } });
    expect(pic.svgAssetId).toBeTruthy();
    expect(result.assets[pic.assetId]).toMatchObject({ role: 'vector-fallback', mime: 'image/png', width: 48, height: 48 });
    expect(result.assets[pic.svgAssetId!]).toMatchObject({ role: 'svg', mime: 'image/svg+xml', width: 24, height: 24 });
    expect(env.exports.map((e) => e.settings.format)).toEqual(['PNG', 'SVG']);
  });

  it('vectors: SVG only when enabled; boolean operations', async () => {
    const off = await run(frame({ width: 800, height: 600, children: [vector({ id: 'v', width: 500, height: 500 })] }), { svgVectors: false });
    expect((off.slide.elements[0] as ImageElement).svgAssetId).toBeNull();
    const bool = await run(frame({ width: 800, height: 600, children: [other('BOOLEAN_OPERATION', { id: 'b', children: [rect(), rect({ x: 50 })] })] }));
    expect((bool.slide.elements[0] as ImageElement).rasterized?.reasons).toEqual(['boolean-operation']);
  });
});

describe('editable mode: clipping', () => {
  it('layers outside the clip are skipped with one report entry for the top-most node', async () => {
    const list = frame({
      id: 'list',
      width: 300,
      height: 100,
      children: [
        text({ id: 'row1', y: 10 }),
        group({ id: 'rows', children: [text({ id: 'row5', y: 500 }), text({ id: 'row6', y: 600 })] }),
        text({ id: 'row9', y: 900 }),
      ],
    });
    const { slide, report } = await run(frame({ width: 800, height: 600, children: [list] }));
    const g = slide.elements[0];
    expect(g.id).toBe('row1'); // single emitted child → spliced
    expect(report.map((r) => [r.level, r.code, r.nodeId])).toEqual([
      ['skipped', 'outside-clip', 'rows'],
      ['skipped', 'outside-clip', 'row9'],
    ]);
  });

  it('partially clipped: image fills cropped, plain rects intersected, others rasterized in place (already clipped)', async () => {
    const env = new FakeEnv();
    env.addImage('photo', JPEG_BYTES, 200, 100);
    const panel = frame({
      id: 'panel',
      x: 100,
      y: 100,
      width: 200,
      height: 200,
      children: [
        rect({ id: 'img', x: -50, y: 0, width: 100, height: 50, fills: [imagePaint('photo')] }),
        rect({ id: 'plain', x: 150, y: 0, width: 100, height: 50, fills: [linear()] }),
        ellipse({ id: 'ell', x: 150, y: 100, width: 100, height: 50 }),
        text({ id: 'txt', x: 150, y: 170, width: 100, height: 20 }),
      ],
    });
    const { slide, report } = await run(frame({ width: 800, height: 600, children: [panel] }), { preserveGroups: false }, env);
    const img = byId<ImageElement>(slide.elements, 'img');
    expect(img.transform).toMatchObject({ x: 100, y: 100, w: 50, h: 50 });
    expect(img.crop).toEqual({ left: 0.5, right: 0, top: 0, bottom: 0 });
    const plain = byId<ShapeElement>(slide.elements, 'plain');
    expect(plain.transform).toMatchObject({ x: 250, y: 100, w: 50, h: 50 });
    // Gradient re-projected onto the smaller box: u_old = 0.5·u_new.
    expect(plain.fill).toMatchObject({ type: 'linear-gradient', gradientTransform: [[0.5, 0, 0], [0, 1, 0]] });
    const ell = byId<ImageElement>(slide.elements, 'ell');
    expect(ell.type).toBe('image');
    expect(ell.rasterized?.reasons).toEqual(['clip']);
    // Figma exported the clipped 50 × 50 region: placed there, never cropped a second time.
    expect(ell.transform).toMatchObject({ x: 250, y: 200, w: 50, h: 50 });
    expect(ell.crop).toBeNull();
    expect(byId<ImageElement>(slide.elements, 'txt').rasterized?.reasons).toEqual(['clip']);
    expect(report.filter((r) => r.code === 'rasterized').map((r) => r.nodeId)).toEqual(['ell', 'txt']);
  });

  it('clippedText "keep" keeps partially clipped text native', async () => {
    const panel = frame({ width: 200, height: 200, children: [text({ id: 'txt', x: 150, width: 100 })] });
    const { slide } = await run(frame({ width: 800, height: 600, children: [panel] }), { clippedText: 'keep' });
    expect(slide.elements[0]).toMatchObject({ id: 'txt', type: 'text' });
  });

  it('cut only by the slide edge: shapes stay native, rects are intersected', async () => {
    const { slide, env } = await run(
      frame({ width: 400, height: 300, children: [ellipse({ id: 'e', x: 350, width: 100, height: 100 }), rect({ id: 'r', x: -50, width: 100, height: 100 })] }),
    );
    expect(byId(slide.elements, 'e').type).toBe('shape');
    expect(byId<ShapeElement>(slide.elements, 'r').transform).toMatchObject({ x: 0, w: 50 });
    expect(env.exports).toHaveLength(0);
  });

  it('rounded clip: corner content is composited with the frame; a covering image stays native', async () => {
    const env = new FakeEnv();
    env.addImage('cover', makePng(400, 200), 400, 200);
    const card = frame({
      id: 'card',
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      cornerRadius: 16,
      fills: [solid('#ffffff')],
      children: [
        rect({ id: 'photo', width: 200, height: 100, fills: [imagePaint('cover')] }),
        rect({ id: 'header', width: 200, height: 20, fills: [solid('#000000')] }),
        text({ id: 'label', x: 20, y: 40, width: 100, height: 20 }),
      ],
    });
    const { slide, env: e } = await run(frame({ width: 800, height: 600, children: [card] }), {}, env);
    const g = slide.elements[0] as GroupElement;
    expect(ids(g.children)).toEqual(['~bg:card', 'photo', '~clip:header', 'label']);
    expect(g.children[1]).toMatchObject({ type: 'image', geometry: 'roundRect', cornerRadius: 16, crop: null });
    const header = g.children[2] as ImageElement;
    expect(header.rasterized?.reasons).toEqual(['clip']);
    expect(header.transform).toMatchObject({ x: 50, y: 50, w: 200, h: 100 });
    const clone = e.exports.find((x) => x.node.clonedFrom)!.node;
    expect(clone.fills).toEqual([]);
    expect(clone.children!.map((c) => (c.clonedFrom as MockNode).id)).toEqual(['header']);
  });

  it('rounded clip: a shape exactly covering the frame stays native with the frame radius', async () => {
    const card = frame({
      id: 'card',
      width: 200,
      height: 100,
      cornerRadius: 16,
      children: [
        frame({ id: 'inner', width: 200, height: 100, fills: [solid('#ff0000')], children: [text({ id: 't', x: 40, y: 40 })] }),
        rect({ id: 'shadowed', width: 200, height: 100, effects: [dropShadow()] }),
      ],
    });
    const { slide } = await run(frame({ width: 800, height: 600, children: [card] }));
    const g = slide.elements[0] as GroupElement;
    const inner = g.children[0] as GroupElement;
    expect(inner.children[0]).toMatchObject({ id: '~bg:inner', type: 'shape', geometry: 'roundRect', cornerRadius: 16 });
    expect(g.children[1]).toMatchObject({ id: '~clip:shadowed', type: 'image' }); // outer shadow would leak
  });

  it('composites inside auto-layout instances detach and freeze the layout before pruning', async () => {
    const card = instance({
      id: 'inst',
      width: 200,
      height: 100,
      cornerRadius: 12,
      layoutMode: 'VERTICAL',
      children: [rect({ id: 'top', width: 200, height: 30 }), rect({ id: 'mid', y: 40, width: 50, height: 20 })],
    });
    const { slide, env } = await run(frame({ width: 800, height: 600, children: [card] }));
    const g = slide.elements[0] as GroupElement;
    expect(ids(g.children)).toEqual(['~clip:top', 'mid']);
    expect(env.detached).toHaveLength(1);
    expect(env.detached[0].layoutMode).toBe('NONE');
    expect(env.detached[0].children!.map((c) => (c.clonedFrom as MockNode).id)).toEqual(['top']);
    expect(card.layoutMode).toBe('VERTICAL'); // original untouched
    expect(card.children!.length).toBe(2);
  });
});

describe('editable mode: images', () => {
  it('FILL / FIT / CROP → picture with original bytes, crop, sub-rect; opacity and stroke overlay', async () => {
    const env = new FakeEnv();
    env.addImage('wide', JPEG_BYTES, 400, 200);
    const root = frame({
      width: 800,
      height: 600,
      children: [
        rect({ id: 'fill', width: 100, height: 100, opacity: 0.5, fills: [imagePaint('wide', 'FILL', { opacity: 0.5 })], strokes: [solid('#000000')], strokeWeight: 2 }),
        rect({ id: 'fit', x: 200, width: 100, height: 100, fills: [imagePaint('wide', 'FIT')] }),
        ellipse({ id: 'crop', x: 400, width: 100, height: 50, fills: [imagePaint('wide', 'CROP', { imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]] })] }),
      ],
    });
    const { slide, result } = await run(root, {}, env);
    expect(ids(slide.elements)).toEqual(['fill', '~stroke:fill', 'fit', 'crop']);
    const fill = slide.elements[0] as ImageElement;
    expect(fill).toMatchObject({ opacity: 0.25, crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 }, geometry: 'rect' });
    expect(slide.elements[1]).toMatchObject({ type: 'shape', opacity: 0.5, fill: null, stroke: { weight: 2 } });
    expect(byId<ImageElement>(slide.elements, 'fit').transform).toMatchObject({ x: 200, y: 25, w: 100, h: 50 });
    expect(byId<ImageElement>(slide.elements, 'crop')).toMatchObject({ geometry: 'ellipse', crop: { left: 0.25, right: 0.25, top: 0.25, bottom: 0.25 } });
    const assets = Object.values(result.assets);
    expect(assets).toHaveLength(1); // one image hash → one asset
    expect(assets[0]).toMatchObject({ role: 'image-fill', mime: 'image/jpeg', width: 400, height: 200, hasAlpha: false, displayWidth: 200, displayHeight: 100 });
  });

  it('unsupported bytes / modes fall back to rasters', async () => {
    const env = new FakeEnv();
    env.addImage('webp', WEBP_BYTES, 10, 10);
    env.addImage('png', makePng(10, 10), 10, 10);
    const root = frame({
      width: 800,
      height: 600,
      children: [
        rect({ id: 'w', fills: [imagePaint('webp')] }),
        rect({ id: 'tile', x: 200, fills: [imagePaint('png', 'TILE')] }),
        rect({ id: 'filters', x: 400, fills: [imagePaint('png', 'FILL', { filters: { saturation: -1 } })] }),
        rect({ id: 'missing', x: 600, fills: [imagePaint('nope')] }),
      ],
    });
    const { slide } = await run(root, {}, env);
    expect(slide.elements.map((e) => [e.id, (e as ImageElement).rasterized?.reasons])).toEqual([
      ['w', ['image-format']],
      ['tile', ['image-fill-mode']],
      ['filters', ['image-filters']],
      ['missing', ['image-format']],
    ]);
  });

  it('dedupes images across slides and re-sends an asset displayed larger later', async () => {
    const env = new FakeEnv();
    env.addImage('logo', makePng(1000, 1000, { colorType: 2 }), 1000, 1000);
    const s1 = frame({ id: 's1', width: 800, height: 600, children: [rect({ width: 50, height: 50, fills: [imagePaint('logo')] })] });
    const s2 = frame({ id: 's2', x: 1000, width: 800, height: 600, children: [rect({ width: 300, height: 300, fills: [imagePaint('logo')] })] });
    onPage(s1, s2);
    const streamed: Array<{ index: number; assets: string[]; display: number[]; bytes: number[]; alpha: unknown[] }> = [];
    const result = await extractDeck([scene(s1), scene(s2)], {
      settings: DEFAULT_SETTINGS,
      env,
      onSlide: (e) => {
        streamed.push({
          index: e.index,
          assets: e.assets.map((a) => a.id),
          display: e.assets.map((a) => a.displayWidth ?? 0),
          bytes: e.assets.map((a) => a.data.length),
          alpha: e.assets.map((a) => a.hasAlpha),
        });
      },
    });
    // Streamed assets are handed over and released by the extractor (the consumer keeps them).
    expect(result.assets).toEqual({});
    const size = makePng(1000, 1000, { colorType: 2 }).length;
    expect(streamed).toEqual([
      { index: 0, assets: ['img1'], display: [50], bytes: [size], alpha: [false] },
      // Re-sent WITH its bytes (re-read by image hash) and the larger display size.
      { index: 1, assets: ['img1'], display: [300], bytes: [size], alpha: [false] },
    ]);
  });
});

describe('editable mode: raster exports', () => {
  it('re-exports with useAbsoluteBounds when the bitmap does not match the render bounds', async () => {
    const env = new FakeEnv();
    env.forceSize = (_n, s) => ('useAbsoluteBounds' in s && s.useAbsoluteBounds ? null : { w: 3, h: 3 });
    const { slide } = await run(frame({ width: 800, height: 600, children: [vector({ id: 'v', x: 10, y: 10, width: 40, height: 20, renderPad: 5 })] }), { svgVectors: false }, env);
    expect(env.exports.map((e) => ('useAbsoluteBounds' in e.settings ? e.settings.useAbsoluteBounds : false))).toEqual([false, true]);
    expect(slide.elements[0].transform).toMatchObject({ x: 10, y: 10, w: 40, h: 20 });
  });

  it('places rasters at the render bounds (shadows included) and clamps huge exports', async () => {
    const env = new FakeEnv();
    const { slide } = await run(
      // Root without clipsContent: Figma does not cut the huge vector at the slide edge, we do.
      frame({ width: 800, height: 600, clipsContent: false, children: [vector({ id: 'v', x: 100, y: 100, width: 50, height: 50, renderPad: 10 }), vector({ id: 'huge', x: 0, y: 300, width: 6000, height: 10 })] }),
      { svgVectors: false, rasterScale: 2 },
      env,
    );
    expect(slide.elements[0].transform).toMatchObject({ x: 90, y: 90, w: 70, h: 70 });
    const hugeExport = env.exports.find((e) => e.node.id === 'huge')!;
    expect((hugeExport.settings as ExportSettingsImage).constraint?.value).toBeCloseTo(8192 / 6000);
    // Cropped to the slide (the only clip Figma did not apply).
    expect(slide.elements[1].transform).toMatchObject({ x: 0, w: 800 });
    expect((slide.elements[1] as ImageElement).crop?.right).toBeCloseTo(5200 / 6000, 3);
  });

  it('a failing export is reported and skipped; the rest of the slide survives', async () => {
    const env = new FakeEnv();
    env.failExport = (n) => n.id === 'bad';
    const { slide, report } = await run(frame({ width: 800, height: 600, children: [vector({ id: 'bad' }), rect({ id: 'ok', x: 200 })] }), {}, env);
    expect(ids(slide.elements)).toEqual(['ok']);
    expect(report).toMatchObject([{ level: 'warning', code: 'export-failed', nodeId: 'bad' }]);
  });

  it('rotated slide root: pictures get the inverse rotation', async () => {
    const root = frame({ width: 400, height: 300, relativeTransform: placement(0, 0, 90), children: [vector({ id: 'v', x: 10, y: 10, width: 50, height: 50 })] });
    const { slide } = await run(root, { svgVectors: false });
    const t = slide.elements[0].transform;
    expect(t.rotation).toBe(90);
    expect(t.x).toBeCloseTo(10);
    expect(t.y).toBeCloseTo(10);
  });

  it('text features PowerPoint lacks are reported, text stays native', async () => {
    const { slide, report } = await run(frame({ width: 800, height: 600, children: [text({ id: 't', leadingTrim: 'CAP_HEIGHT', textTruncation: 'ENDING' })] }));
    expect(slide.elements[0].type).toBe('text');
    expect(report.map((r) => r.code)).toEqual(['text-leading-trim', 'text-truncated']);
  });

  it('lines cut by a clipping frame are rasterized; rotated clipping frames with overflow rasterize whole', async () => {
    const { slide } = await run(
      frame({
        width: 800,
        height: 600,
        children: [
          frame({ id: 'clipper', width: 100, height: 100, children: [line({ id: 'l', x: 50, y: 50, width: 200 })] }),
          frame({ id: 'rot', x: 300, y: 300, relativeTransform: placement(300, 300, 30), width: 100, height: 100, children: [rect({ x: 60, width: 100 })] }),
        ],
      }),
    );
    expect(slide.elements.map((e) => [e.id, (e as ImageElement).rasterized?.reasons])).toEqual([
      ['l', ['clip']],
      ['rot', ['clip']],
    ]);
  });

  it('missing fonts stay native with a warning', async () => {
    const { slide, report } = await run(frame({ width: 800, height: 600, children: [text({ id: 't', hasMissingFont: true })] }));
    expect(slide.elements[0].type).toBe('text');
    expect(report).toMatchObject([{ level: 'warning', code: 'missing-font', nodeId: 't' }]);
  });
});

describe('exact and image modes', () => {
  it('exact: background composite with native texts hidden (opacity 0), texts on top', async () => {
    const root = frame({
      id: 'root',
      width: 800,
      height: 600,
      fills: [solid('#123456')],
      children: [
        rect({ id: 'r' }),
        group({ id: 'g', children: [text({ id: 't1', x: 10 }), text({ id: 'grad', x: 200, fills: [linear()] })] }),
        group({ id: 'blend', blendMode: 'SCREEN', children: [text({ id: 't-blend', x: 400 })] }),
        text({ id: 't2', y: 300 }),
      ],
    });
    const { slide, env, report } = await run(root, { mode: 'exact' });
    expect(ids(slide.elements)).toEqual(['~exact:root', 't1', 't2']);
    expect(slide.elements[0]).toMatchObject({ type: 'image', transform: { x: 0, y: 0, w: 800, h: 600 }, rasterized: { reasons: ['exact-mode'] } });
    expect(env.exports).toHaveLength(1);
    const clone = env.exports[0].node;
    expect(env.exports[0].settings).toMatchObject({ format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'SCALE', value: 2 } });
    const texts = clone.findAllWithCriteria({ types: ['TEXT'] });
    expect(texts.map((t) => [(t.clonedFrom as MockNode).id, t.opacity])).toEqual([
      ['t1', 0],
      ['grad', 1],
      ['t-blend', 1],
      ['t2', 0],
    ]);
    // Originals untouched, auto layout-safe (opacity, not visibility).
    expect(root.findAllWithCriteria({ types: ['TEXT'] }).every((t) => t.opacity === 1 && t.visible)).toBe(true);
    expect(report.map((r) => [r.nodeId, r.reasons])).toEqual([
      ['grad', ['gradient-text']],
      ['t-blend', ['blend-mode']],
      ['root', ['exact-mode']],
    ]);
    const asset = Object.values((await run(frame({ width: 10, height: 10 }), { mode: 'exact' })).result.assets)[0];
    expect(asset.role).toBe('background');
  });

  it('exact: texts in a root mask range stay in the background', async () => {
    const root = frame({
      id: 'root',
      width: 800,
      height: 600,
      children: [text({ id: 'free' }), ellipse({ id: 'm', isMask: true }), text({ id: 'masked' })],
    });
    const { slide, report } = await run(root, { mode: 'exact' });
    expect(ids(slide.elements)).toEqual(['~exact:root', 'free']);
    expect(report.map((r) => [r.nodeId, r.reasons])).toEqual([
      ['masked', ['mask']],
      ['root', ['exact-mode']],
    ]);
  });

  it('image: one picture per slide', async () => {
    const { slide, env, report, result } = await run(frame({ id: 'root', width: 800, height: 600, children: [text(), rect()] }), { mode: 'image', rasterScale: 1 });
    expect(slide.elements).toHaveLength(1);
    expect(slide.elements[0]).toMatchObject({ id: '~image:root', type: 'image', rasterized: { reasons: ['image-mode'] } });
    expect(env.exports).toHaveLength(1);
    expect(env.exports[0].node.id).toBe('root');
    expect(Object.values(result.assets)[0]).toMatchObject({ role: 'background', width: 800, height: 600 });
    expect(report).toMatchObject([{ level: 'raster', code: 'rasterized', reasons: ['image-mode'] }]);
  });
});

describe('cancellation and cleanup', () => {
  it('cancels at the next yield and removes temporary nodes', async () => {
    const env = new FakeEnv();
    let cancelled = false;
    env.onExport = () => {
      cancelled = true;
    };
    const kids = Array.from({ length: 60 }, (_, i) => rect({ x: i * 10, width: 5, height: 5 }));
    const root = frame({ width: 800, height: 600, fills: [radial()], children: [vector(), ...kids] });
    onPage(root);
    await expect(extractDeck([scene(root)], { settings: DEFAULT_SETTINGS, env, isCancelled: () => cancelled })).rejects.toMatchObject({
      name: 'ExtractCancelledError',
    });
    expect(env.liveClones()).toEqual([]);
  });

  it('removes composite clones when an export throws', async () => {
    const env = new FakeEnv();
    env.failExport = (n) => !!n.clonedFrom;
    const { slide, report } = await run(frame({ id: 'root', width: 800, height: 600, fills: [radial()], children: [rect({ id: 'r' })] }), {}, env);
    expect(ids(slide.elements)).toEqual(['r']);
    expect(report).toMatchObject([{ code: 'export-failed', nodeId: 'root' }]);
    expect(env.clones.every((c) => c.removed)).toBe(true);
  });

  it('streams progress and yields to Figma', async () => {
    const env = new FakeEnv();
    const phases = new Set<string>();
    const kids = Array.from({ length: 60 }, (_, i) => vector({ x: i * 10, width: 5, height: 5 }));
    await run(frame({ width: 800, height: 600, children: kids }), {}, env, { onProgress: (p) => phases.add(p.phase) });
    expect(env.yields).toBeGreaterThanOrEqual(2);
    expect([...phases].sort()).toEqual(['export', 'walk']);
  });
});
