/**
 * intersectShape re-maps a linear gradient onto the clipped box. A flipped box runs its local axis the
 * other way (IR contract: the gradient lives in the box's unrotated LOCAL space, flips included), so
 * the offset is measured from the far edge.
 */
import { beforeEach, expect, it } from 'vitest';
import { intersectShape } from '../../src/extract/walker';
import type { LinearGradientFill, ShapeElement } from '../../src/ir/types';
import { frame, linear, rect, resetIds } from '../helpers/figma-mocks';
import { flat, run } from './helpers';

beforeEach(() => resetIds());

/** Gradient parameter t at a slide point, per the IR contract (flip in the box's local space). */
function tAt(el: ShapeElement, px: number, py: number): number {
  const t = el.transform;
  let u = (px - t.x) / t.w;
  let v = (py - t.y) / t.h;
  if (t.flipH) u = 1 - u;
  if (t.flipV) v = 1 - v;
  const g = (el.fill as LinearGradientFill).gradientTransform;
  return g[0][0] * u + g[0][1] * v + g[0][2];
}

const shapeWith = (transform: ShapeElement['transform'], gradientTransform: LinearGradientFill['gradientTransform']): ShapeElement => ({
  type: 'shape',
  id: 's',
  name: 's',
  transform,
  opacity: 1,
  shadow: null,
  geometry: 'rect',
  cornerRadius: 0,
  fill: { type: 'linear-gradient', stops: [], gradientTransform },
  stroke: null,
});

it('flipped gradient rect cut by a clipping frame keeps its colours', async () => {
  // Clip frame at slide x 100..200; the mirrored rect spans slide x 100..300 (local origin at its right edge).
  const r = rect({ id: 'r', x: 200, y: 0, width: 200, height: 100, mirror: true, fills: [linear()] });
  const clipper = frame({ id: 'clip', x: 100, y: 100, width: 100, height: 100, children: [r] });
  const { slide } = await run(frame({ width: 800, height: 600, children: [clipper] }), { preserveGroups: false });
  const el = flat(slide.elements).find((e) => e.id === 'r') as ShapeElement;
  expect(el.transform).toMatchObject({ x: 100, w: 100, flipH: true, rotation: 0 }); // intersected natively
  // Unclipped: slide x 100..300 ↔ local u 1..0, so slide x = 150 is u = 0.75 → t = 0.75.
  expect(tAt(el, 150, 150)).toBeCloseTo(0.75, 6);
  expect(tAt(el, 100, 150)).toBeCloseTo(1, 6);
  expect(tAt(el, 200, 150)).toBeCloseTo(0.5, 6);
});

it('every slide point keeps its gradient value, unflipped and flipped on both axes', () => {
  const g: LinearGradientFill['gradientTransform'] = [
    [0.6, 0.3, 0.05],
    [-0.3, 0.6, 0.2],
  ];
  const inter = { x: 130, y: 70, w: 50, h: 40 };
  for (const [flipH, flipV] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    const before = shapeWith({ x: 100, y: 50, w: 200, h: 100, rotation: 0, flipH, flipV }, g);
    const after = intersectShape(before, inter);
    expect(after.transform).toMatchObject({ x: 130, y: 70, w: 50, h: 40, flipH, flipV });
    for (const [px, py] of [
      [130, 70],
      [180, 110],
      [155, 95],
    ]) {
      expect(tAt(after, px, py)).toBeCloseTo(tAt(before, px, py), 9);
    }
  }
});
