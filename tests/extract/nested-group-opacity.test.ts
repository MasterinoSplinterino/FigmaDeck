/**
 * "Group opacity over overlapping children": the overlap test looks at every painting piece the walk
 * would produce below the translucent container (leaves, own-paint boxes of walked frames, containers
 * that become one picture), not only at its direct children.
 */
import { beforeEach, expect, it } from 'vitest';
import { containerRasterReasons } from '../../src/extract/classify';
import { IDENTITY } from '../../src/extract/geometry';
import type { Element, ImageElement } from '../../src/ir/types';
import { MIXED, frame, group, onPage, rect, resetIds, scene, solid, text, vector } from '../helpers/figma-mocks';
import { flat, run } from './helpers';

beforeEach(() => resetIds());

const reasonsOf = (els: Element[]) => els.filter((e) => e.type === 'image').map((e) => [e.id, (e as ImageElement).rasterized?.reasons]);

it('flat: two overlapping rects in a 50% group → one raster (baseline)', async () => {
  const g = group({ id: 'g', opacity: 0.5, children: [rect({ id: 'a', width: 600, height: 100 }), rect({ id: 'b', x: 50, y: 50, width: 100, height: 100, fills: [solid('#0000ff')] })] });
  const { slide } = await run(frame({ width: 800, height: 600, children: [g] }));
  expect(reasonsOf(flat(slide.elements))).toEqual([['g', ['group-opacity']]]);
});

it('nested: the same overlap one level deeper → one raster, not two 50% native shapes', async () => {
  const inner = group({ id: 'inner', children: [rect({ id: 'a', width: 600, height: 100 }), rect({ id: 'b', x: 50, y: 50, width: 100, height: 100, fills: [solid('#0000ff')] })] });
  const g = group({ id: 'g', opacity: 0.5, children: [inner] });
  const { slide } = await run(frame({ width: 800, height: 600, children: [g] }));
  expect(reasonsOf(flat(slide.elements))).toEqual([['g', ['group-opacity']]]);
});

it('nested, real-world: 50% card wrapper → frame with a fill → text', async () => {
  const content = frame({ id: 'content', width: 300, height: 120, clipsContent: false, fills: [solid('#ffffff')], children: [text({ id: 'label', x: 20, y: 20, width: 200 })] });
  const card = frame({ id: 'card', x: 10, y: 10, width: 300, height: 120, opacity: 0.5, clipsContent: false, children: [content] });
  const { slide } = await run(frame({ width: 800, height: 600, children: [card] }));
  expect(reasonsOf(flat(slide.elements))).toEqual([['card', ['group-opacity']]]);
});

it('no overlap at any depth → stays native with the opacity multiplied in', async () => {
  const inner = group({ id: 'inner', children: [rect({ id: 'a', width: 100, height: 100 }), rect({ id: 'b', x: 200, width: 100, height: 100 })] });
  const g = group({ id: 'g', opacity: 0.5, children: [inner, text({ id: 't', x: 400, width: 100 })] });
  const { slide } = await run(frame({ width: 800, height: 600, children: [g] }));
  const els = flat(slide.elements);
  expect(reasonsOf(els)).toEqual([]);
  expect(els.filter((e) => e.type !== 'group').map((e) => [e.id, e.opacity])).toEqual([
    ['a', 0.5],
    ['b', 0.5],
    ['t', 0.5],
  ]);
});

it('a descendant that becomes ONE picture counts as one piece (its own overlaps are inside the bitmap)', () => {
  // The icon's vectors overlap each other, but the icon is exported as one picture: no group-opacity.
  const icon = group({ id: 'icon', width: 24, height: 24, children: [vector({ width: 24, height: 24 }), vector({ x: 4, y: 4, width: 16, height: 16 })] });
  const g = group({ id: 'g', opacity: 0.5, children: [icon, text({ id: 't', x: 100, width: 100 })] });
  const root = frame({ width: 800, height: 600, children: [g] });
  onPage(root);
  expect(containerRasterReasons(scene(g), MIXED, IDENTITY)).toEqual([]);
  // …while an overlap between that picture and a sibling piece deeper down still counts.
  const g2 = group({ id: 'g2', opacity: 0.5, children: [icon, group({ children: [text({ x: 10, width: 100 })] })] });
  frame({ width: 800, height: 600, children: [g2] });
  expect(containerRasterReasons(scene(g2), MIXED, IDENTITY)).toEqual(['group-opacity']);
});
