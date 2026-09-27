/**
 * Extractor behaviour that depends on Figma facts verified in the real Plugin API
 * (docs/figma-api-notes.md): clipped render bounds / exports, ceil-sized bitmaps, own-opacity baking,
 * frame stroke order, temporary clones on the current page, CROP direction, AUTO line height.
 * The mocks (tests/helpers/figma-mocks.ts) follow the same facts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { extractDeck, type ExtractDeckOptions } from '../../src/extract';
import { AssetStore } from '../../src/extract/assets';
import { createLineHeightMeasurer, resolveAutoLineHeights } from '../../src/extract/line-height';
import { readPngInfo } from '../../src/extract/png';
import { exportComposite, mapToOriginal, TempNodes } from '../../src/extract/raster';
import { isSlideNode } from '../../src/extract/selection';
import { extendAtCutEdges } from '../../src/extract/walker';
import type { Element, GroupElement, ImageElement, ShapeElement, TextElement, TextParagraph } from '../../src/ir/types';
import { DEFAULT_SETTINGS, type ExportSettings } from '../../src/shared/settings';
import {
  FakeEnv,
  component,
  doc,
  dropShadow,
  ellipse,
  frame,
  group,
  imagePaint,
  instance,
  JPEG_BYTES,
  line,
  linear,
  onPage,
  page,
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
  expect(env.autoLayoutRemovals).toEqual([]); // never trimmed a clone with auto layout still on
  return { result, slide: result.slides[0], env, report: result.report };
}

/** Depth-first list of all elements (groups flattened, groups themselves included). */
function all(els: Element[]): Element[] {
  return els.flatMap((e) => (e.type === 'group' ? [e, ...all(e.children)] : [e]));
}
const find = <T extends Element>(els: Element[], id: string) => all(els).find((e) => e.id === id) as T;
const ids = (els: Element[]) => els.map((e) => e.id);
const origin = (n: MockNode): string => (n.clonedFrom ? origin(n.clonedFrom as MockNode) : n.id);
const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('clipping: render bounds and exports are already clipped by Figma', () => {
  it('the mock behaves like Figma: 200×50 child of a 100×100 clipping frame → 100×50 bounds and bitmap; clipped away → null, 1×1', async () => {
    const child = vector({ id: 'child', x: 0, y: 25, width: 200, height: 50 });
    const gone = vector({ id: 'gone', x: 300, width: 50, height: 50 });
    onPage(frame({ id: 'clipper', width: 100, height: 100, children: [child, gone] }));
    expect(child.absoluteRenderBounds).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(child.absoluteBoundingBox).toEqual({ x: 0, y: 25, width: 200, height: 50 });
    const env = new FakeEnv();
    expect(readPngInfo(await env.exportAsync(scene(child), { format: 'PNG' }))).toMatchObject({ width: 100, height: 50 });
    expect(gone.absoluteRenderBounds).toBeNull();
    expect(readPngInfo(await env.exportAsync(scene(gone), { format: 'PNG' }))).toMatchObject({ width: 1, height: 1 });
  });

  it('a raster inside a clipping frame is placed at the clipped render bounds, size = PNG / scale, not cropped again', async () => {
    const clipper = frame({
      id: 'clipper',
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      children: [vector({ id: 'v', x: 0, y: 25, width: 200, height: 50 }), text({ id: 't', x: 10, y: 80, width: 50, height: 15 })],
    });
    const { slide, env, result } = await run(frame({ width: 800, height: 600, children: [clipper] }), { svgVectors: false, preserveGroups: false });
    const v = find<ImageElement>(slide.elements, 'v');
    expect(v).toMatchObject({ type: 'image', crop: null, rasterized: { reasons: ['vector'] } });
    expect(v.transform).toEqual({ x: 100, y: 125, w: 100, h: 50, rotation: 0, flipH: false, flipV: false });
    expect(env.exports.map((e) => e.node.id)).toEqual(['v']);
    expect(result.assets[v.assetId]).toMatchObject({ width: 200, height: 100, displayWidth: 100, displayHeight: 50 });
  });

  it('visible nodes clipped away entirely (render bounds null) are skipped: one outside-clip entry per top-most node', async () => {
    const clipper = frame({
      id: 'clipper',
      width: 100,
      height: 100,
      children: [
        vector({ id: 'in', width: 50, height: 50 }),
        vector({ id: 'gone', x: 300, width: 50, height: 50 }),
        group({ id: 'far', children: [vector({ id: 'far1', y: 200 }), text({ id: 'far2', y: 400 })] }),
        text({ id: 'inText', x: 10, y: 60, width: 50 }),
      ],
    });
    const { slide, env, report } = await run(frame({ width: 800, height: 600, children: [clipper] }), { preserveGroups: false });
    expect(ids(slide.elements)).toEqual(['in', 'inText']);
    expect(report.filter((r) => r.code === 'outside-clip').map((r) => [r.level, r.nodeId])).toEqual([
      ['skipped', 'gone'],
      ['skipped', 'far'],
    ]);
    expect([...new Set(env.exports.map((e) => e.node.id))]).toEqual(['in']);
  });

  it('nodes that paint nothing (no render bounds, no paint) are skipped silently', async () => {
    const { slide, report } = await run(
      frame({
        width: 800,
        height: 600,
        children: [
          rect({ id: 'nofill', fills: [], renderBounds: null }),
          frame({ id: 'emptyFrame', renderBounds: null }),
          text({ id: 'blank', characters: '', segments: [], renderBounds: null }),
          group({ id: 'hiddenKids', renderBounds: null, children: [rect({ visible: false })] }),
        ],
      }),
    );
    expect(slide.elements).toEqual([]);
    expect(report).toEqual([]);
  });

  it('native text: cut glyphs are detected from the layout box; an oversized box alone is no cut', async () => {
    const clipper = frame({
      id: 'clipper',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      children: [
        // Layout box 250..350, glyphs 252..342 → cut at 300 (render bounds stop exactly there).
        text({ id: 'cut', x: 150, y: 0, width: 100, height: 20, renderBounds: { x: 252, y: 105, w: 90, h: 12 } }),
        // Same box, glyphs 252..282: nothing is cut.
        text({ id: 'loose', x: 150, y: 40, width: 100, height: 20, renderBounds: { x: 252, y: 145, w: 30, h: 12 } }),
      ],
    });
    const { slide } = await run(frame({ width: 800, height: 600, children: [clipper] }));
    const cut = find<ImageElement>(slide.elements, 'cut');
    expect(cut).toMatchObject({ type: 'image', rasterized: { reasons: ['clip'] }, crop: null });
    expect(cut.transform).toMatchObject({ x: 252, y: 105, w: 48, h: 12 }); // Figma's clipped glyph bitmap
    expect(find(slide.elements, 'loose').type).toBe('text');

    const kept = await run(frame({ width: 800, height: 600, children: [clipper] }), { clippedText: 'keep' });
    expect(find(kept.slide.elements, 'cut').type).toBe('text');
  });

  it('shapes: a cut shadow makes the shape a raster in place; a plain rect filling its clip frame stays native', async () => {
    const clipper = frame({
      id: 'clipper',
      x: 400,
      y: 100,
      width: 100,
      height: 100,
      children: [
        rect({ id: 'plain', width: 100, height: 100 }),
        rect({ id: 'shadowed', width: 100, height: 100, effects: [dropShadow()], renderPad: 10 }),
      ],
    });
    const { slide } = await run(frame({ width: 800, height: 600, children: [clipper] }));
    expect(find<ShapeElement>(slide.elements, 'plain')).toMatchObject({ type: 'shape', transform: { x: 400, y: 100, w: 100, h: 100 } });
    const shadowed = find<ImageElement>(slide.elements, 'shadowed');
    expect(shadowed).toMatchObject({ type: 'image', rasterized: { reasons: ['clip'] }, crop: null });
    expect(shadowed.transform).toMatchObject({ x: 400, y: 100, w: 100, h: 100 });
  });

  it('a full-width divider line in a clipping card stays native; a centred stroke on the frame edge is a cut', async () => {
    const card = frame({
      id: 'card',
      x: 100,
      y: 100,
      width: 300,
      height: 100,
      children: [
        line({ id: 'divider', y: 50, width: 300 }),
        rect({ id: 'edge', width: 300, height: 30, strokes: [solid('#000000')], strokeAlign: 'CENTER', strokeWeight: 2, renderPad: 1, y: 70 }),
      ],
    });
    const { slide } = await run(frame({ width: 800, height: 600, children: [card] }));
    expect(find(slide.elements, 'divider')).toMatchObject({ type: 'shape', geometry: 'line', transform: { x: 100, y: 150, w: 300, h: 0 } });
    expect(find(slide.elements, 'edge')).toMatchObject({ type: 'image', rasterized: { reasons: ['clip'] } });
  });

  it('extendAtCutEdges: box beyond → box; box inside → 1 px; box on the edge → only for overhanging shapes', () => {
    const cut = { x: 0, y: 0, w: 100, h: 100 };
    // Glyphs cut at the right edge of a wider text box.
    expect(extendAtCutEdges({ x: 50, y: 10, w: 50, h: 10 }, { x: 50, y: 10, w: 50, h: 10 }, { x: 40, y: 5, w: 90, h: 20 }, cut, false)).toEqual({ x: 50, y: 10, w: 80, h: 10 });
    // Render overhangs a box that is inside: cut → 1 px past the edge.
    expect(extendAtCutEdges({ x: 0, y: 10, w: 20, h: 10 }, { x: 0, y: 10, w: 20, h: 10 }, { x: 5, y: 10, w: 10, h: 10 }, cut, false)).toEqual({ x: -1, y: 10, w: 21, h: 10 });
    // Box on the edge: only a shape painting past its own box counts as cut.
    const onEdge = { x: 0, y: 40, w: 30, h: 20 };
    expect(extendAtCutEdges(onEdge, onEdge, onEdge, cut, false)).toEqual(onEdge);
    expect(extendAtCutEdges(onEdge, onEdge, onEdge, cut, true)).toEqual({ x: -1, y: 40, w: 31, h: 20 });
    // Away from the edges: unchanged.
    const inside = { x: 10, y: 10, w: 10, h: 10 };
    expect(extendAtCutEdges(inside, inside, inside, cut, true)).toEqual(inside);
  });

  it('native image fills are still cropped by hand (srcRect) to the clip', async () => {
    const env = new FakeEnv();
    env.addImage('photo', JPEG_BYTES, 100, 100);
    const clipper = frame({ id: 'clipper', width: 100, height: 100, children: [rect({ id: 'img', x: 50, width: 100, height: 100, fills: [imagePaint('photo')] })] });
    const { slide } = await run(frame({ width: 800, height: 600, children: [clipper] }), { preserveGroups: false }, env);
    expect(find<ImageElement>(slide.elements, 'img')).toMatchObject({
      transform: { x: 50, y: 0, w: 50, h: 100 },
      crop: { left: 0, right: 0.5, top: 0, bottom: 0 },
    });
  });
});

describe('placement: PNG = ceil(bounds × scale), placed with PNG / scale', () => {
  it('plain export with fractional render bounds', async () => {
    const { slide, result, env } = await run(
      frame({ width: 800, height: 600, children: [vector({ id: 'v', x: 10.25, y: 20.5, width: 20.3, height: 10.1 })] }),
      { svgVectors: false, rasterScale: 2 },
    );
    const v = slide.elements[0] as ImageElement;
    expect(v.transform).toMatchObject({ x: 10.25, y: 20.5, w: 20.5, h: 10.5 });
    expect(result.assets[v.assetId]).toMatchObject({ width: 41, height: 21, displayWidth: 20.5, displayHeight: 10.5 });
    expect(env.exports[0].settings).toEqual({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
  });

  it('useAbsoluteBounds fallback: placed at the bounding box origin, size PNG / scale', async () => {
    const env = new FakeEnv();
    env.forceSize = (_n, s) => ('useAbsoluteBounds' in s && s.useAbsoluteBounds ? null : { w: 3, h: 3 });
    const { slide } = await run(
      frame({ width: 800, height: 600, children: [vector({ id: 'v', x: 10.25, y: 10, width: 20.3, height: 10, renderPad: 5 })] }),
      { svgVectors: false },
      env,
    );
    expect(env.exports.map((e) => ('useAbsoluteBounds' in e.settings ? e.settings.useAbsoluteBounds : false))).toEqual([false, true]);
    expect(slide.elements[0].transform).toMatchObject({ x: 10.25, y: 10, w: 20.5, h: 10 });
  });

  it('composites: clone render bounds, size PNG / scale', async () => {
    const card = frame({
      id: 'card',
      x: 50.5,
      y: 50,
      width: 200.25,
      height: 100,
      cornerRadius: 16,
      children: [rect({ id: 'corner', width: 40, height: 40 }), text({ id: 'label', x: 60, y: 40 })],
    });
    const { slide } = await run(frame({ width: 800, height: 600, children: [card] }));
    const pic = find<ImageElement>(slide.elements, '~clip:corner');
    expect(pic.transform).toMatchObject({ x: 50.5, y: 50, w: 200.5, h: 100 });
    expect(pic.crop).toBeNull();
  });

  it('image / exact slide pictures: frame box origin, PNG / scale, never cropped', async () => {
    for (const mode of ['image', 'exact'] as const) {
      resetIds();
      const { slide, result } = await run(frame({ id: 'root', width: 100.3, height: 50, children: [text({ id: 't' })] }), { mode, rasterScale: 2 });
      const pic = slide.elements[0] as ImageElement;
      expect(pic.transform).toMatchObject({ x: 0, y: 0, w: 100.5, h: 50 });
      expect(pic.crop).toBeNull();
      expect(result.assets[pic.assetId]).toMatchObject({ width: 201, height: 100, role: 'background' });
    }
  });

  it('SVG next to the PNG gets the picture box as its viewport (1 unit = 1 px, like the PNG)', async () => {
    const { slide, result } = await run(frame({ width: 800, height: 600, children: [vector({ id: 'v', width: 20.3, height: 10.1 })] }), { rasterScale: 2 });
    const v = slide.elements[0] as ImageElement;
    const svg = result.assets[v.svgAssetId!];
    expect(svg).toMatchObject({ mime: 'image/svg+xml', width: 20.5, height: 10.5 });
    const head = decode(svg.data);
    expect(head).toContain('width="20.5" height="10.5" viewBox="0 0 20.5 10.5" fill="none"');
    expect(head).toContain('<rect/></svg>');
  });
});

describe('opacity: own opacity is in the bitmap, ancestors are the picture alpha', () => {
  it('plain rasters, rounded-clip composites, own-paint composites and root mask composites', async () => {
    // No own fill and non-overlapping children: the card's opacity does not force a group raster.
    const card = frame({
      id: 'card',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      cornerRadius: 16,
      opacity: 0.5,
      children: [rect({ id: 'corner', width: 40, height: 40, opacity: 0.5 }), text({ id: 'label', x: 60, y: 40 })],
    });
    const bgFrame = frame({ id: 'f', x: 400, y: 100, width: 200, height: 100, opacity: 0.5, fills: [radial()] });
    const g = group({ id: 'g', opacity: 0.5, children: [card, bgFrame, vector({ id: 'v', x: 700, y: 100, width: 40, height: 40, opacity: 0.5 })] });
    const root = frame({
      id: 'root',
      width: 800,
      height: 600,
      opacity: 0.8,
      children: [g, ellipse({ id: 'm', isMask: true, x: 0, y: 400, width: 50, height: 50 }), rect({ id: 'masked', x: 0, y: 400, opacity: 0.5 })],
    });
    const { slide, env } = await run(root, { svgVectors: false });
    const el = (id: string) => find(slide.elements, id);
    expect(el('v').opacity).toBe(0.4); // root 0.8 × group 0.5; its own 0.5 is in the bitmap
    expect(el('~clip:corner').opacity).toBe(0.4); // ancestors of the cloned card
    expect(el('~bg:f').opacity).toBe(0.4); // ancestors of the cloned frame
    expect(el('~mask:m').opacity).toBe(1); // the root clone bakes the root's opacity
    // Natives carry the full product.
    expect(el('label').opacity).toBe(0.2);
    expect(el('masked')).toBeUndefined(); // inside the mask composite

    const exported = (id: string) => env.exports.find((e) => origin(e.node) === id)!.node;
    const cardClone = exported('card');
    expect(cardClone.fills).toEqual([]); // paints stripped, opacity kept
    expect(cardClone.opacity).toBe(0.5);
    expect(cardClone.children!.map((c) => [origin(c), c.opacity])).toEqual([['corner', 0.5]]);
    expect(exported('f').opacity).toBe(0.5);
    expect(exported('root').opacity).toBe(0.8);
    expect(exported('v').opacity).toBe(0.5);
  });
});

describe('frame strokes: under the children without clipping, on top with clipping', () => {
  const card = (id: string, clipsContent: boolean, props: Record<string, unknown>) =>
    frame({ id, clipsContent, width: 200, height: 100, children: [rect({ id: `${id}-child`, x: 20, y: 20, width: 20, height: 20 })], ...props });

  it('native fill + rasterized (gradient) stroke', async () => {
    const { slide, env } = await run(
      frame({
        width: 800,
        height: 600,
        children: [
          card('open', false, { fills: [solid('#eeeeee')], strokes: [linear()] }),
          card('clip', true, { x: 300, fills: [solid('#eeeeee')], strokes: [linear()] }),
        ],
      }),
    );
    const [open, clip] = slide.elements as GroupElement[];
    expect(ids(open.children)).toEqual(['~bg:open', '~stroke:open', 'open-child']);
    expect(ids(clip.children)).toEqual(['~bg:clip', 'clip-child', '~stroke:clip']);
    const strokeClone = env.exports.find((e) => origin(e.node) === 'open')!.node;
    expect(strokeClone.children).toEqual([]);
    expect(strokeClone.fills).toEqual([]);
    expect(strokeClone.strokes).toHaveLength(1);
  });

  it('image fill + native stroke', async () => {
    const env = new FakeEnv();
    env.addImage('photo', JPEG_BYTES, 200, 100);
    const { slide } = await run(
      frame({
        width: 800,
        height: 600,
        children: [
          card('open', false, { fills: [imagePaint('photo')], strokes: [solid('#000000')] }),
          card('clip', true, { x: 300, fills: [imagePaint('photo')], strokes: [solid('#000000')] }),
        ],
      }),
      {},
      env,
    );
    const [open, clip] = slide.elements as GroupElement[];
    expect(open.children.map((c) => [c.id, c.type])).toEqual([
      ['~bg:open', 'image'],
      ['~stroke:open', 'shape'],
      ['open-child', 'shape'],
    ]);
    expect(ids(clip.children)).toEqual(['~bg:clip', 'clip-child', '~stroke:clip']);
  });
});

describe('temporary composites', () => {
  it('deck frame on another page: clones land on the CURRENT page, placement uses the original coordinates', async () => {
    const card = frame({
      id: 'card',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      cornerRadius: 16,
      children: [rect({ id: 'corner', width: 40, height: 40 }), text({ id: 'label', x: 60, y: 40 })],
    });
    const root = frame({ id: 'root', x: 5000, y: 3000, width: 800, height: 600, fills: [radial()], children: [card] });
    const pageA = page({ id: 'A' });
    const pageB = page({ id: 'B', children: [root] });
    doc([pageA, pageB]);
    const env = new FakeEnv();
    env.currentPage = pageA;
    const parents: string[] = [];
    env.onExport = (n) => parents.push(n.parent?.id ?? 'none');
    const { slide } = await run(root, {}, env);
    expect(parents).toEqual(['A', 'A']);
    expect(pageA.children).toEqual([]);
    expect(pageB.children!.map((n) => n.id)).toEqual(['root']);
    expect(find(slide.elements, '~bg:root').transform).toMatchObject({ x: 0, y: 0, w: 800, h: 600 });
    expect(find(slide.elements, '~clip:corner').transform).toMatchObject({ x: 100, y: 100, w: 200, h: 100 });
  });

  it('a clone that did not get the original position is mapped back through the original transform', async () => {
    class OffsetEnv extends FakeEnv {
      holder = frame({ id: 'holder', x: 1000, y: -500, clipsContent: false });
      constructor() {
        super();
        this.currentPage.appendChild(this.holder);
      }
      override clone(node: SceneNode): SceneNode {
        const c = super.clone(node) as unknown as MockNode;
        this.holder.appendChild(c); // e.g. a parent that is not the page root
        return c as unknown as SceneNode;
      }
    }
    const env = new OffsetEnv();
    const seen: unknown[] = [];
    env.onExport = (n) => seen.push(n.absoluteRenderBounds);
    const card = frame({ id: 'card', x: 40, y: 30, width: 200, height: 100, children: [rect({ id: 'r' })] });
    onPage(card);
    const ctx = { env, settings: DEFAULT_SETTINGS, assets: new AssetStore(), temp: new TempNodes(env) };
    const r = await exportComposite(ctx, { ancestor: scene(card), keep: [] }, 'raster');
    expect(seen).toEqual([{ x: 1040, y: -470, width: 200, height: 100 }]); // where the clone really was
    expect(r?.region).toEqual({ x: 40, y: 30, w: 200, h: 100 }); // where the original is
    expect(mapToOriginal({ x: 1, y: 2, w: 3, h: 4 }, [[1, 0, 10], [0, 1, 20]], [[1, 0, 0], [0, 1, 0]])).toEqual({ x: -9, y: -18, w: 3, h: 4 });
  });

  it('detachInstance: the NEW node is tracked and removed; auto layout is off before children go', async () => {
    const inst = instance({
      id: 'inst',
      x: 10,
      y: 10,
      width: 200,
      height: 100,
      layoutMode: 'VERTICAL',
      fills: [radial()],
      children: [text({ id: 't', x: 20, y: 20 }), rect({ id: 'r', x: 100, y: 20, width: 20, height: 20 })],
    });
    const { slide, env } = await run(frame({ width: 800, height: 600, children: [inst] }));
    expect(ids((slide.elements[0] as GroupElement).children)).toEqual(['~bg:inst', 't', 'r']);
    expect(env.detached).toHaveLength(1);
    const detached = env.detached[0];
    const exported = env.exports[0].node;
    expect(exported).toBe(detached);
    expect(detached.id).not.toBe(env.clones[0].id); // new id; the instance clone is gone
    expect(env.clones[0].removed).toBe(true);
    expect(detached.removed).toBe(true);
    expect(detached.layoutMode).toBe('NONE');
    expect(inst.layoutMode).toBe('VERTICAL');
  });

  it('nested auto-layout instance inside a rounded card: detached and frozen before pruning, nothing left behind', async () => {
    const row = instance({
      id: 'row',
      width: 200,
      height: 40,
      layoutMode: 'HORIZONTAL',
      children: [rect({ id: 'corner', width: 40, height: 40 }), rect({ id: 'mid', x: 80, width: 40, height: 20 })],
    });
    const card = frame({ id: 'card', width: 200, height: 100, cornerRadius: 16, layoutMode: 'VERTICAL', children: [row, text({ id: 'label', x: 20, y: 60 })] });
    const { slide, env } = await run(frame({ width: 800, height: 600, children: [card] }), { preserveGroups: false });
    expect(ids(slide.elements)).toEqual(['~clip:corner', 'mid', 'label']);
    expect(env.detached.map((d) => d.layoutMode)).toEqual(['NONE']);
    const exported = env.exports[0].node;
    expect(exported.layoutMode).toBe('NONE');
    expect(exported.children!.map(origin)).toEqual(['row']);
    expect(exported.children![0].children!.map(origin)).toEqual(['corner']);
    expect([row.layoutMode, row.children!.length, card.layoutMode, card.children!.length]).toEqual(['HORIZONTAL', 2, 'VERTICAL', 2]);
  });

  it('a removed COMPONENT that is still resolvable (parent null) is not a slide; temp cleanup tolerates it', () => {
    const c = component({ id: 'c' });
    onPage(c);
    expect(isSlideNode(scene(c))).toBe(true);
    c.parent!.children!.splice(0, 1);
    c.parent = null; // Figma: resolvable by id, parent === null
    expect(isSlideNode(scene(c))).toBe(false);
    const env = new FakeEnv();
    const temp = new TempNodes(env);
    temp.track(scene(c));
    expect(() => temp.release(scene(c))).not.toThrow();
    expect(temp.count).toBe(0);
  });
});

describe('CROP imageTransform: layer unit box → image unit box', () => {
  it('[[0.5,0,0.25],[0,0.5,0.1]] shows u 0.25..0.75, v 0.1..0.6 as a native picture', async () => {
    const env = new FakeEnv();
    env.addImage('img', JPEG_BYTES, 1000, 1000);
    const { slide } = await run(
      frame({ width: 800, height: 600, children: [rect({ id: 'crop', width: 100, height: 100, fills: [imagePaint('img', 'CROP', { imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.1]] })] })] }),
      {},
      env,
    );
    expect(slide.elements[0]).toMatchObject({ type: 'image', crop: { left: 0.25, right: 0.25, top: 0.1, bottom: 0.4 } });
  });
});

describe('AUTO line height: measured per font and size', () => {
  const lh = (t: TextElement) => t.paragraphs.map((p) => [p.runs.map((r) => r.lineHeight), p.endStyle.lineHeight]);

  it('Inter 60 → 73, 13 → 16, 12 → 15 px (natural height rounded); measured once per key; temp nodes removed', async () => {
    const t = text({
      id: 't',
      segments: [
        { characters: 'Big\n', fontSize: 60 },
        { characters: 'mid\n', fontSize: 13 },
        { characters: 'small', fontSize: 12 },
      ],
    });
    const t2 = text({ id: 't2', y: 200, segments: [{ characters: 'again', fontSize: 13 }] });
    const { slide, env } = await run(frame({ width: 800, height: 600, children: [t, t2] }));
    const px = (value: number) => ({ unit: 'PIXELS', value });
    expect(lh(find<TextElement>(slide.elements, 't'))).toEqual([
      [[px(73)], px(73)],
      [[px(16)], px(16)],
      [[px(15)], px(15)],
    ]);
    expect(lh(find<TextElement>(slide.elements, 't2'))).toEqual([[[px(16)], px(16)]]);
    expect(env.fontLoads).toHaveLength(3);
    expect(env.createdTexts).toHaveLength(3);
    expect(env.createdTexts.every((n) => n.removed)).toBe(true);
    expect(env.createdTexts.map((n) => [n.characters, n.textAutoResize, n.lineHeight])).toEqual(
      Array(3).fill(['Ag', 'WIDTH_AND_HEIGHT', { unit: 'AUTO' }]),
    );
  });

  it('a font that cannot be loaded keeps AUTO; explicit line heights and rasterized text are not measured', async () => {
    const env = new FakeEnv();
    env.missingFonts.add('SB Sans::Regular');
    const { slide } = await run(
      frame({
        width: 800,
        height: 600,
        children: [
          text({ id: 'missing', fontName: { family: 'SB Sans', style: 'Regular' }, hasMissingFont: true }),
          text({ id: 'pct', y: 100, lineHeight: { unit: 'PERCENT', value: 110 } }),
          text({ id: 'grad', y: 200, fills: [linear()] }),
        ],
      }),
      {},
      env,
    );
    expect(lh(find<TextElement>(slide.elements, 'missing'))).toEqual([[[{ unit: 'AUTO' }], { unit: 'AUTO' }]]);
    expect(lh(find<TextElement>(slide.elements, 'pct'))).toEqual([[[{ unit: 'PERCENT', value: 110 }], { unit: 'PERCENT', value: 110 }]]);
    expect(find(slide.elements, 'grad').type).toBe('image');
    expect(env.fontLoads).toEqual([{ family: 'SB Sans', style: 'Regular' }]);
    expect(env.createdTexts).toEqual([]);
  });

  it('exact mode measures its native texts too', async () => {
    const { slide } = await run(frame({ width: 800, height: 600, children: [text({ id: 't', fontSize: 60 })] }), { mode: 'exact' });
    expect(lh(find<TextElement>(slide.elements, 't'))).toEqual([[[{ unit: 'PIXELS', value: 73 }], { unit: 'PIXELS', value: 73 }]]);
  });

  it('measurer: failures give null (cached), nodes are released', async () => {
    const env = new FakeEnv();
    env.createText = () => {
      throw new Error('no');
    };
    const temp = new TempNodes(env);
    const measure = createLineHeightMeasurer(env, temp);
    expect(await measure({ family: 'Inter', style: 'Regular' }, 12)).toBeNull();
    expect(await measure({ family: 'Inter', style: 'Regular' }, 12)).toBeNull();
    expect(env.fontLoads).toHaveLength(1);
    expect(await measure({ family: 'Inter', style: 'Regular' }, 0)).toBeNull();
    expect(temp.count).toBe(0);

    const ok = new FakeEnv();
    const paragraphs = [
      { runs: [{ fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 12, lineHeight: { unit: 'AUTO' } }], endStyle: { fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 12, lineHeight: { unit: 'AUTO' } } },
    ] as unknown as TextParagraph[];
    await resolveAutoLineHeights(paragraphs, createLineHeightMeasurer(ok, new TempNodes(ok)));
    expect(paragraphs[0].runs[0].lineHeight).toEqual({ unit: 'PIXELS', value: 15 });
    expect(paragraphs[0].endStyle.lineHeight).toEqual({ unit: 'PIXELS', value: 15 });
  });
});

describe('raster reasons of the contract', () => {
  it('unsupported paints → "unsupported-paint"; image fills rasterized by the setting → "setting"', async () => {
    const env = new FakeEnv();
    env.addImage('photo', JPEG_BYTES, 10, 10);
    const video = { type: 'VIDEO', visible: true, opacity: 1, blendMode: 'NORMAL' } as unknown as Paint;
    const { slide, report } = await run(
      frame({
        width: 800,
        height: 600,
        children: [
          rect({ id: 'video', fills: [video] }),
          rect({ id: 'photo', x: 200, fills: [imagePaint('photo')] }),
          text({ id: 'vtext', y: 300, fills: [video] }),
        ],
      }),
      { imageFills: 'rasterize' },
      env,
    );
    expect(slide.elements.map((e) => [e.id, (e as ImageElement).rasterized?.reasons])).toEqual([
      ['video', ['unsupported-paint']],
      ['photo', ['setting']],
      ['vtext', ['unsupported-paint']],
    ]);
    expect(report.map((r) => r.message)).toEqual([
      expect.stringContaining('paint type without a PowerPoint equivalent'),
      expect.stringContaining('export setting'),
      expect.stringContaining('paint type without a PowerPoint equivalent'),
    ]);
  });
});
