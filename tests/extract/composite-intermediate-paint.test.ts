/**
 * Rounded-clip / own-paint composites: the clone keeps the paths to the exported content, and every
 * container a path only PASSES THROUGH loses its own fills / strokes / effects (they are separate
 * elements of the slide). Opacity is baked once: the clone keeps every opacity from the cloned root
 * down, the picture gets only the opacity above the root.
 */
import { beforeEach, expect, it } from 'vitest';
import type { ImageElement, TextElement } from '../../src/ir/types';
import { dropShadow, frame, group, rect, resetIds, solid, text, vector, type MockNode } from '../helpers/figma-mocks';
import { flat, run } from './helpers';

beforeEach(() => resetIds());

/** The composite clone exported for the original node `id` (found through the clone provenance). */
function cloneRootFor(exports: Array<{ node: MockNode }>, id: string): MockNode | undefined {
  const contains = (n: MockNode): boolean => (n.clonedFrom as MockNode | undefined)?.id === id || (n.children ?? []).some(contains);
  return exports.find((x) => x.node.clonedFrom && contains(x.node))?.node;
}

it('corner vector inside a filled sub-frame of a rounded card: picture = vector only, not the sub-frame paint', async () => {
  const card = frame({
    id: 'card', x: 50, y: 50, width: 200, height: 100, cornerRadius: 16, fills: [solid('#ffffff')],
    children: [
      frame({
        id: 'header', x: 0, y: 0, width: 200, height: 50, clipsContent: false,
        fills: [solid('#0000ff')], strokes: [solid('#000000')], effects: [dropShadow()],
        children: [
          rect({ id: 'badge', x: 60, y: 10, width: 20, height: 20 }), // native, below the vector
          vector({ id: 'icon', x: 0, y: 0, width: 30, height: 30 }), // reaches the card's rounded TL corner
          text({ id: 'title', x: 100, y: 15, width: 80, height: 20 }), // makes the header non-icon-like
        ],
      }),
    ],
  });
  const { slide, env } = await run(frame({ id: 'root', width: 800, height: 600, children: [card] }));
  const els = flat(slide.elements);
  expect(els.find((e) => e.id === '~clip:icon')).toBeDefined();
  expect(els.findIndex((e) => e.id === 'badge')).toBeLessThan(els.findIndex((e) => e.id === '~clip:icon'));

  const root = cloneRootFor(env.exports, 'icon')!;
  expect(root.children).toHaveLength(1);
  const headerClone = root.children![0];
  expect((headerClone.clonedFrom as MockNode).id).toBe('header');
  // The pass-through header paints nothing in the icon's picture (its fill / stroke / shadow are
  // the separate '~bg:header' / '~stroke:header' elements)…
  expect(headerClone.fills).toEqual([]);
  expect(headerClone.strokes).toEqual([]);
  expect(headerClone.effects).toEqual([]);
  // …but keeps what shapes the content: clip flag, geometry.
  expect(headerClone.clipsContent).toBe(false);
  expect(headerClone.children!.map((c) => (c.clonedFrom as MockNode).id)).toEqual(['icon']);
  // The cloned root only provides the clip.
  expect(root.fills).toEqual([]);
  expect(root.cornerRadius).toBe(16);
  expect(root.clipsContent).toBe(true);
  // The original is untouched.
  expect((card.children![0] as MockNode).fills).toHaveLength(1);
});

it('own-paint composite of a nested frame: pass-through containers stripped, the target keeps its fill', async () => {
  const chip = frame({
    id: 'chip', x: 0, y: 0, width: 60, height: 30, fills: [solid('#ff00ff')],
    children: [text({ id: 'chipLabel', x: 20, y: 5, width: 30, height: 20 })],
  });
  const card = frame({
    id: 'card', x: 50, y: 50, width: 200, height: 100, cornerRadius: 16,
    children: [frame({ id: 'row', width: 200, height: 40, clipsContent: false, fills: [solid('#00ff00')], children: [chip] })],
  });
  const { slide, env } = await run(frame({ id: 'root', width: 800, height: 600, children: [card] }));
  const els = flat(slide.elements);
  const chipBg = els.find((e) => e.id === '~bg:chip') as ImageElement;
  expect(chipBg.rasterized?.reasons).toEqual(['clip']);
  // The composite for the chip background: card → row (stripped) → chip (fill kept, children removed).
  const call = env.exports.find((x) => {
    const row = x.node.children?.[0];
    const c = row?.children?.[0];
    return x.node.clonedFrom && (c?.clonedFrom as MockNode | undefined)?.id === 'chip';
  })!;
  const rowClone = call.node.children![0];
  expect(rowClone.fills).toEqual([]);
  const chipClone = rowClone.children![0];
  expect(chipClone.fills).toHaveLength(1);
  expect(chipClone.children).toEqual([]);
  expect(els.find((e) => e.id === 'chipLabel')?.type).toBe('text');
});

it('opacity inside the clone is baked once; the picture gets the opacity above the cloned frame', async () => {
  const card = frame({
    id: 'card', width: 200, height: 100, cornerRadius: 16, opacity: 0.8,
    children: [
      group({
        id: 'grp', opacity: 0.6,
        children: [vector({ id: 'icon', width: 30, height: 30, opacity: 0.9 }), text({ id: 'label', x: 100, y: 15, width: 80, height: 20 })],
      }),
    ],
  });
  const wrap = frame({ id: 'wrap', x: 50, y: 50, width: 200, height: 100, opacity: 0.5, clipsContent: false, children: [card] });
  const { slide, env } = await run(frame({ id: 'root', width: 800, height: 600, children: [wrap] }));
  const els = flat(slide.elements);
  const icon = els.find((e) => e.id === '~clip:icon') as ImageElement;
  // Only the wrapper's opacity: card 0.8 × group 0.6 × icon 0.9 are in the bitmap.
  expect(icon.opacity).toBe(0.5);
  const root = cloneRootFor(env.exports, 'icon')!;
  expect(root.opacity).toBe(0.8);
  const grpClone = root.children![0];
  expect(grpClone.opacity).toBe(0.6);
  expect(grpClone.children!.map((c) => [(c.clonedFrom as MockNode).id, c.opacity])).toEqual([['icon', 0.9]]);
  // Native siblings get the whole product.
  expect((els.find((e) => e.id === 'label') as TextElement).opacity).toBeCloseTo(0.5 * 0.8 * 0.6, 9);
});
