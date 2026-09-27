import { describe, expect, it } from 'vitest';
import {
  applyToPoint,
  clean,
  containsRect,
  decompose,
  intersectRects,
  invert,
  isQuarterTurn,
  multiply,
  normalizeDegrees,
  placeAbsoluteRect,
  rectsEqual,
  transformBounds,
  transformRectBounds,
  transformedBoxBounds,
  unionRects,
} from '../../src/extract/geometry';
import type { Matrix } from '../../src/ir/types';
import { placement } from '../helpers/figma-mocks';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('matrices', () => {
  it('multiplies in the "apply right first" order', () => {
    const t: Matrix = [
      [1, 0, 10],
      [0, 1, 20],
    ];
    const s: Matrix = [
      [2, 0, 0],
      [0, 3, 0],
    ];
    // scale then translate
    expect(applyToPoint(multiply(t, s), { x: 1, y: 1 })).toEqual({ x: 12, y: 23 });
    // translate then scale
    expect(applyToPoint(multiply(s, t), { x: 1, y: 1 })).toEqual({ x: 22, y: 63 });
  });

  it('inverts affine matrices', () => {
    const m = placement(30, 40, 33);
    const p = applyToPoint(multiply(invert(m), m), { x: 5, y: -7 });
    near(p.x, 5);
    near(p.y, -7);
  });

  it('throws on singular matrices', () => {
    expect(() =>
      invert([
        [0, 0, 1],
        [0, 0, 1],
      ]),
    ).toThrow();
  });
});

describe('decompose', () => {
  it('identity placement', () => {
    const d = decompose(placement(10, 20), 100, 50);
    expect(d.transform).toEqual({ x: 10, y: 20, w: 100, h: 50, rotation: 0, flipH: false, flipV: false });
    expect(d.skewed).toBe(false);
    expect(d.flipped).toBe(false);
  });

  it('Figma rotation (counter-clockwise) → clockwise degrees about the center', () => {
    // Rotated 90° CCW about the top-left corner at (0, 100): the box spans x 0..50, y 0..100.
    const d = decompose(placement(0, 100, 90), 100, 50);
    expect(d.transform.rotation).toBe(270);
    // Center of the rotated box: (25, 50) → unrotated box around it.
    expect(d.transform.x).toBe(-25);
    expect(d.transform.y).toBe(25);
    expect(d.transform.w).toBe(100);
    expect(d.transform.h).toBe(50);
  });

  it('arbitrary rotations', () => {
    const d = decompose(placement(0, 0, -30), 10, 10);
    near(d.transform.rotation, 30);
    const e = decompose(placement(0, 0, 45), 10, 10);
    near(e.transform.rotation, 315);
  });

  it('snaps float noise to quarter turns', () => {
    const m: Matrix = [
      [1e-9 - 1, -1e-9, 0],
      [1e-9, -1, 0],
    ];
    expect(decompose(m, 10, 10).transform.rotation).toBe(180);
  });

  it('mirror → flipH with the rotation of M·diag(-1,1)', () => {
    const d = decompose(placement(100, 0, 0, true), 100, 50);
    expect(d.flipped).toBe(true);
    expect(d.transform.flipH).toBe(true);
    expect(d.transform.flipV).toBe(false);
    expect(d.transform.rotation).toBe(0);
    // Mirrored about x = 100: the box spans x 0..100.
    expect(d.transform.x).toBe(0);
    // Vertical flip = horizontal flip + 180° rotation.
    const v: Matrix = [
      [1, 0, 0],
      [0, -1, 50],
    ];
    const dv = decompose(v, 100, 50);
    expect(dv.transform.flipH).toBe(true);
    expect(dv.transform.rotation).toBe(180);
    expect(dv.transform.y).toBe(0);
  });

  it('flags skew and scale', () => {
    const skew: Matrix = [
      [1, 0.5, 0],
      [0, 1, 0],
    ];
    expect(decompose(skew, 10, 10).skewed).toBe(true);
    const scale: Matrix = [
      [2, 0, 0],
      [0, 2, 0],
    ];
    expect(decompose(scale, 10, 10).skewed).toBe(true);
    expect(decompose(placement(0, 0, 17), 10, 10).skewed).toBe(false);
  });
});

describe('rects', () => {
  it('intersect / union / contains / equal', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 5, w: 10, h: 10 };
    expect(intersectRects(a, b)).toEqual({ x: 5, y: 5, w: 5, h: 5 });
    expect(intersectRects(a, { x: 10, y: 0, w: 5, h: 5 })).toBeNull();
    expect(unionRects([a, b])).toEqual({ x: 0, y: 0, w: 15, h: 15 });
    expect(unionRects([])).toBeNull();
    expect(containsRect(a, { x: 1, y: 1, w: 8, h: 8 })).toBe(true);
    expect(containsRect(a, b)).toBe(false);
    expect(containsRect(a, { x: -0.2, y: 0, w: 10.3, h: 10 })).toBe(true); // tolerance
    expect(rectsEqual(a, { x: 0.1, y: 0, w: 10, h: 9.9 })).toBe(true);
  });

  it('bounds of rotated boxes', () => {
    expect(transformBounds({ x: 0, y: 0, w: 100, h: 50, rotation: 90, flipH: false, flipV: false })).toEqual({ x: 25, y: -25, w: 50, h: 100 });
    const r = transformBounds({ x: 0, y: 0, w: 10, h: 10, rotation: 45, flipH: true, flipV: false });
    near(r.w, Math.SQRT2 * 10);
    near(r.x, 5 - (Math.SQRT2 * 10) / 2);
    expect(transformedBoxBounds(placement(0, 100, 90), 100, 50)).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(transformRectBounds(placement(-10, -20), { x: 10, y: 20, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 5, h: 5 });
  });

  it('places absolute rects in slide space (translated and rotated frames)', () => {
    expect(placeAbsoluteRect(invert(placement(100, 200)), { x: 110, y: 220, w: 30, h: 40 })).toEqual({
      x: 10,
      y: 20,
      w: 30,
      h: 40,
      rotation: 0,
      flipH: false,
      flipV: false,
    });
    const t = placeAbsoluteRect(invert(placement(0, 0, 90)), { x: 0, y: -10, w: 10, h: 10 });
    expect(t.rotation).toBe(90);
  });
});

describe('numbers', () => {
  it('clean / normalizeDegrees / isQuarterTurn', () => {
    expect(clean(1e-13)).toBe(0);
    expect(clean(-1e-13)).toBe(0);
    expect(Object.is(clean(-0), 0)).toBe(true);
    expect(clean(99.9999999)).toBe(100);
    expect(clean(0.1234567891)).toBe(0.123457);
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(360)).toBe(0);
    expect(normalizeDegrees(359.999)).toBe(0);
    expect(isQuarterTurn(270)).toBe(true);
    expect(isQuarterTurn(45)).toBe(false);
  });
});
