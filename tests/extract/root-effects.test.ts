/**
 * Effects of the slide ROOT (which never rasterizes as a whole): inner shadow / layer blur / noise are
 * drawn with the slide background (native inner shadow when possible, else a background composite
 * WITH the effects, first element); drop shadow and background blur are outside the slide (info);
 * whatever cannot be kept is reported, never dropped silently.
 */
import { beforeEach, expect, it } from 'vitest';
import type { ImageElement, ShapeElement } from '../../src/ir/types';
import { dropShadow, frame, innerShadow, layerBlur, radial, rect, resetIds, solid, type MockNode } from '../helpers/figma-mocks';
import { run } from './helpers';

beforeEach(() => resetIds());

const summary = (x: Awaited<ReturnType<typeof run>>) => ({
  ids: x.slide.elements.map((e) => e.id),
  report: x.report.map((r) => [r.level, r.code]),
});

it('inner shadow on a solid root → native background shape with the inner shadow, below everything', async () => {
  const root = frame({ id: 'root', width: 800, height: 600, fills: [solid('#ffffff')], effects: [innerShadow({ radius: 120 })], children: [rect({ id: 'r' })] });
  const x = await run(root);
  expect(summary(x)).toEqual({ ids: ['~bg:root', 'r'], report: [] });
  expect(x.slide.background).toMatchObject({ type: 'solid' }); // <p:bg> stays
  const bg = x.slide.elements[0] as ShapeElement;
  expect(bg).toMatchObject({ type: 'shape', geometry: 'rect', fill: { type: 'solid' }, shadow: { type: 'inner', blur: 120 } });
  expect(bg.transform).toMatchObject({ x: 0, y: 0, w: 800, h: 600 });
});

it('layer blur on the root → background composite with the blur (first) + warning (layers stay sharp)', async () => {
  const root = frame({ id: 'root', width: 800, height: 600, fills: [solid('#ffffff')], effects: [layerBlur(10)], children: [rect({ id: 'r' })] });
  const x = await run(root);
  expect(summary(x)).toEqual({
    ids: ['~bg:root', 'r'],
    report: [
      ['warning', 'root-effect-dropped'],
      ['raster', 'rasterized'],
    ],
  });
  expect((x.slide.elements[0] as ImageElement).rasterized?.reasons).toEqual(['blur']);
  const clone = x.env.exports[0].node;
  expect((clone.clonedFrom as MockNode).id).toBe('root');
  expect(clone.children).toEqual([]);
  expect(clone.effects).toHaveLength(1); // the blur is in the bitmap
});

it('inner shadow that cannot be native (spread) / noise → background composite with the effects', async () => {
  const spread = await run(frame({ id: 'root', width: 400, height: 300, fills: [solid('#ffffff')], effects: [innerShadow({ spread: 4 })], children: [rect({ id: 'r' })] }));
  expect(summary(spread).ids).toEqual(['~bg:root', 'r']);
  expect((spread.slide.elements[0] as ImageElement).rasterized?.reasons).toEqual(['effects']);
  expect(spread.env.exports[0].node.effects).toHaveLength(1);

  const noise = { type: 'NOISE', noiseType: 'MONOTONE', visible: true, blendMode: 'NORMAL', noiseSize: 1, density: 0.5, color: { r: 0, g: 0, b: 0, a: 0.2 } } as unknown as Effect;
  const n = await run(frame({ id: 'root', width: 400, height: 300, fills: [solid('#ffffff')], effects: [noise], children: [rect({ id: 'r' })] }));
  expect(summary(n)).toEqual({ ids: ['~bg:root', 'r'], report: [['raster', 'rasterized']] });
  expect((n.slide.elements[0] as ImageElement).rasterized?.reasons).toEqual(['effects']);
});

it('gradient root with an inner shadow → one composite with fill + effects', async () => {
  const x = await run(frame({ id: 'root', width: 400, height: 300, fills: [radial()], effects: [innerShadow()], children: [rect({ id: 'r' })] }));
  expect(summary(x).ids).toEqual(['~bg:root', 'r']);
  expect((x.slide.elements[0] as ImageElement).rasterized?.reasons).toEqual(['gradient', 'effects']);
  expect(x.env.exports[0].node.effects).toHaveLength(1);
});

it('a root without a fill cannot carry its effects → dropped with a warning', async () => {
  const x = await run(frame({ id: 'root', width: 400, height: 300, effects: [innerShadow(), layerBlur(4)], children: [rect({ id: 'r' })] }));
  expect(summary(x)).toEqual({ ids: ['r'], report: [['warning', 'root-effect-dropped']] });
  expect(x.report[0].message).toContain('inner shadow, layer blur');
});

it('drop shadow / background blur of the root are ignored with an info entry; the background stays <p:bg>', async () => {
  const bgBlur = { type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: 8, visible: true } as unknown as Effect;
  const x = await run(frame({ id: 'root', width: 400, height: 300, fills: [solid('#ffffff')], effects: [dropShadow(), dropShadow(), bgBlur], children: [rect({ id: 'r' })] }));
  expect(summary(x)).toEqual({
    ids: ['r'],
    report: [
      ['info', 'root-effect-ignored'],
      ['info', 'root-effect-ignored'],
    ],
  });
  expect(x.slide.background).toMatchObject({ type: 'solid' });
});

it('invisible / zero effects are no effects', async () => {
  const x = await run(
    frame({
      id: 'root', width: 400, height: 300, fills: [solid('#ffffff')],
      effects: [innerShadow({ visible: false }), layerBlur(0), innerShadow({ color: { r: 0, g: 0, b: 0, a: 0 } })],
      children: [rect({ id: 'r' })],
    }),
  );
  expect(summary(x)).toEqual({ ids: ['r'], report: [] });
});
