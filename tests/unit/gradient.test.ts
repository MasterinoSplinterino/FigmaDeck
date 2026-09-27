import { describe, expect, it } from 'vitest';
import { convertLinearGradient, gradientFillXml, type GradientConversion } from '../../src/build/gradient';
import type { Color, GradientStop, LinearGradientFill, Matrix } from '../../src/ir/types';

const RED: Color = { r: 1, g: 0, b: 0, a: 1 };
const BLUE: Color = { r: 0, g: 0, b: 1, a: 1 };
const GREEN: Color = { r: 0, g: 1, b: 0, a: 0.5 };

function lin(stops: GradientStop[], m: Matrix): LinearGradientFill {
  return { type: 'linear-gradient', stops, gradientTransform: m };
}

const IDENTITY: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
];

function linear(g: GradientConversion) {
  if (g.kind !== 'linear') throw new Error('expected a linear gradient');
  return g;
}

type Rgba = [number, number, number, number];
const mix = (a: Rgba, b: Rgba, t: number): Rgba => [0, 1, 2, 3].map((i) => a[i] + (b[i] - a[i]) * t) as Rgba;

/** Piecewise-linear color with end padding (both Figma and PowerPoint semantics). */
function sample(stops: Array<{ at: number; c: Rgba }>, x: number): Rgba {
  if (x <= stops[0].at) return stops[0].c;
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i].at) {
      const span = stops[i].at - stops[i - 1].at;
      return span > 0 ? mix(stops[i - 1].c, stops[i].c, (x - stops[i - 1].at) / span) : stops[i].c;
    }
  }
  return stops[stops.length - 1].c;
}

/**
 * Compares the rendered colors of the Figma gradient and of the converted OOXML gradient at many
 * points of the box (OOXML geometry: line through the center at `angleDeg`, length |w cos| + |h sin|).
 */
function expectSameRendering(fill: LinearGradientFill, w: number, h: number, opacity = 1): void {
  const g = convertLinearGradient(fill, w, h, opacity);
  const [[m00, m01, m02]] = fill.gradientTransform;
  const figmaStops = [...fill.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ at: s.position, c: [s.color.r, s.color.g, s.color.b, s.color.a * opacity] as Rgba }));
  const ooxml =
    g.kind === 'linear'
      ? g.stops.map((s) => ({ at: s.pos / 100000, c: [s.color.r, s.color.g, s.color.b, s.alpha] as Rgba }))
      : [{ at: 0, c: [g.color.r, g.color.g, g.color.b, g.alpha] as Rgba }];
  const rad = g.kind === 'linear' ? (g.angleDeg * Math.PI) / 180 : 0;
  const L = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const px = (w * i) / 8;
      const py = (h * j) / 8;
      const t = m00 * (px / w) + m01 * (py / h) + m02;
      const q = ((px - w / 2) * Math.cos(rad) + (py - h / 2) * Math.sin(rad)) / L + 0.5;
      const want = sample(figmaStops, t);
      const got = sample(ooxml, g.kind === 'linear' ? q : 0);
      for (let k = 0; k < 4; k++) expect(got[k]).toBeCloseTo(want[k], 3);
    }
  }
}

describe('convertLinearGradient', () => {
  it('identity transform → left to right, angle 0, positions unchanged', () => {
    const g = linear(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 0.3, color: GREEN }, { position: 1, color: BLUE }], IDENTITY), 200, 100, 1));
    expect(g.ang).toBe(0);
    expect(g.stops.map((s) => s.pos)).toEqual([0, 30000, 100000]);
    expect(g.stops[1].alpha).toBeCloseTo(0.5, 10);
  });

  it('top to bottom → 90°', () => {
    const m: Matrix = [
      [0, 1, 0],
      [-1, 0, 1],
    ];
    const g = linear(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: BLUE }], m), 300, 100, 1));
    expect(g.ang).toBe(5400000);
    expect(g.stops.map((s) => s.pos)).toEqual([0, 100000]);
  });

  it('right to left → 180°', () => {
    const m: Matrix = [
      [-1, 0, 1],
      [0, -1, 1],
    ];
    const g = linear(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: BLUE }], m), 100, 100, 1));
    expect(g.ang).toBe(180 * 60000);
    expect(g.stops.map((s) => s.pos)).toEqual([0, 100000]);
  });

  it('corner to corner on a square: 45°, the gradient ends at the center', () => {
    const m: Matrix = [
      [1, 1, 0],
      [-1, 1, 0.5],
    ];
    const g = linear(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: BLUE }], m), 100, 100, 1));
    expect(g.ang).toBe(45 * 60000);
    expect(g.stops.map((s) => s.pos)).toEqual([0, 50000]);
  });

  it('corner to corner on a non-square box: angle in pixel space, ends at the corners', () => {
    const m: Matrix = [
      [0.5, 0.5, 0],
      [-0.5, 0.5, 0.5],
    ];
    const g = linear(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: BLUE }], m), 200, 100, 1));
    expect(g.angleDeg).toBeCloseTo((Math.atan2(0.5 / 100, 0.5 / 200) * 180) / Math.PI, 9);
    expect(g.stops.map((s) => s.pos)).toEqual([0, 100000]);
  });

  it('stops outside the box are clipped with interpolated boundary colors', () => {
    // t runs 0.25 → 0.75 across the box: stops 0 and 1 land at q = −0.5 and 1.5.
    const m: Matrix = [
      [0.5, 0, 0.25],
      [0, 1, 0],
    ];
    const g = linear(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: BLUE }], m), 100, 100, 1));
    expect(g.stops.map((s) => s.pos)).toEqual([0, 100000]);
    expect(g.stops[0].color.r).toBeCloseTo(0.75, 9);
    expect(g.stops[0].color.b).toBeCloseTo(0.25, 9);
    expect(g.stops[1].color.r).toBeCloseTo(0.25, 9);
    expect(g.stops[1].color.b).toBeCloseTo(0.75, 9);
  });

  it('keeps hard stops (two stops at the same position) in order', () => {
    const g = linear(
      convertLinearGradient(
        lin([{ position: 0, color: RED }, { position: 0.5, color: RED }, { position: 0.5, color: BLUE }, { position: 1, color: BLUE }], IDENTITY),
        100,
        50,
        1,
      ),
    );
    expect(g.stops.map((s) => s.pos)).toEqual([0, 50000, 50000, 100000]);
    expect(g.stops[1].color).toEqual(RED);
    expect(g.stops[2].color).toEqual(BLUE);
  });

  it('degenerate gradient (no change across the box) → solid of the first stop', () => {
    const m: Matrix = [
      [0, 0, 0.3],
      [0, 0, 0],
    ];
    const g = convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: BLUE }], m), 100, 100, 0.5);
    expect(g).toEqual({ kind: 'solid', color: RED, alpha: 0.5 });
  });

  it('single stop / empty box → solid', () => {
    expect(convertLinearGradient(lin([{ position: 0.4, color: BLUE }], IDENTITY), 100, 100, 1).kind).toBe('solid');
    expect(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: BLUE }], IDENTITY), 0, 100, 1).kind).toBe('solid');
  });

  it('multiplies every stop alpha by the element opacity', () => {
    const g = linear(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: GREEN }], IDENTITY), 100, 100, 0.5));
    expect(g.stops.map((s) => s.alpha)).toEqual([0.5, 0.25]);
  });

  it.each([
    ['rotated 30° in normalized space', 30, 320, 160],
    ['rotated 115°', 115, 100, 300],
    ['rotated 250°', 250, 640, 90],
    ['rotated −10°', -10, 50, 50],
  ])('renders like Figma: %s', (_label, deg, w, h) => {
    const a = (Number(deg) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const m: Matrix = [
      [c, s, 0.5 - 0.5 * c - 0.5 * s],
      [-s, c, 0.5 + 0.5 * s - 0.5 * c],
    ];
    expectSameRendering(lin([{ position: 0, color: RED }, { position: 0.4, color: GREEN }, { position: 1, color: BLUE }], m), Number(w), Number(h), 0.8);
  });

  it.each([
    ['scaled and offset (stops beyond both ends)', [[0.4, 0.1, 0.3], [0, 1, 0]] as Matrix, 200, 120],
    ['steep (stops inside)', [[2.5, -1.2, -0.4], [0, 1, 0]] as Matrix, 90, 400],
    ['negative direction', [[-0.7, -0.7, 1.2], [0, 1, 0]] as Matrix, 300, 300],
  ])('renders like Figma: %s', (_label, m, w, h) => {
    expectSameRendering(lin([{ position: 0.1, color: RED }, { position: 0.6, color: GREEN }, { position: 0.9, color: BLUE }], m), w, h, 1);
  });
});

describe('gradientFillXml', () => {
  it('writes gsLst + lin with scaled="0" and rotWithShape="1"', () => {
    const xml = gradientFillXml(convertLinearGradient(lin([{ position: 0, color: RED }, { position: 1, color: GREEN }], IDENTITY), 100, 100, 1));
    expect(xml).toBe(
      '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
        '<a:gs pos="100000"><a:srgbClr val="00FF00"><a:alpha val="50000"/></a:srgbClr></a:gs></a:gsLst>' +
        '<a:lin ang="0" scaled="0"/></a:gradFill>',
    );
  });

  it('writes a solid fill for degenerate gradients', () => {
    expect(gradientFillXml({ kind: 'solid', color: BLUE, alpha: 1 })).toBe('<a:solidFill><a:srgbClr val="0000FF"/></a:solidFill>');
  });
});
