import { describe, expect, it } from 'vitest';
import {
  anyOverlap,
  classifyLine,
  classifyShape,
  containerRasterReasons,
  hasDefaultArc,
  isIconLike,
  lineTransform,
  relativeMatrix,
} from '../../src/extract/classify';
import { IDENTITY } from '../../src/extract/geometry';
import type { Matrix } from '../../src/ir/types';
import {
  MIXED,
  booleanOp,
  dropShadow,
  ellipse,
  frame,
  group,
  imagePaint,
  innerShadow,
  layerBlur,
  line,
  linear,
  placement,
  radial,
  rect,
  scene,
  solid,
  text,
  vector,
} from '../helpers/figma-mocks';

const settings = { nativeGradients: true, imageFills: 'original' as const };
const shape = (n: ReturnType<typeof rect>, opts = {}) => classifyShape(scene(n), MIXED, settings, relativeMatrix(IDENTITY, scene(n)), opts);

describe('RECTANGLE rules', () => {
  it('solid fill → native rect; uniform radius → roundRect (clamped)', () => {
    const d = shape(rect({ x: 5, y: 6, width: 40, height: 20 }));
    expect(d).toMatchObject({ kind: 'native', geometry: 'rect', radius: 0, fill: { type: 'solid' }, stroke: null, shadow: null });
    expect(d.transform).toEqual({ x: 5, y: 6, w: 40, h: 20, rotation: 0, flipH: false, flipV: false });
    expect(shape(rect({ width: 40, height: 20, cornerRadius: 50 }))).toMatchObject({ geometry: 'roundRect', radius: 10 });
  });

  it('linear gradient native (setting), stroke + dash + one shadow native', () => {
    expect(shape(rect({ fills: [linear()] }))).toMatchObject({ kind: 'native', fill: { type: 'linear-gradient' } });
    const d = shape(rect({ strokes: [solid('#00ff00')], strokeWeight: 3, dashPattern: [2, 2], effects: [innerShadow()] }));
    expect(d.kind).toBe('native');
    expect(d.stroke).toMatchObject({ weight: 3, dash: [2, 2] });
    expect(d.shadow?.type).toBe('inner');
  });

  it('one IMAGE fill → image; rasterize setting → raster with reason "setting"', () => {
    expect(shape(rect({ fills: [imagePaint('abc')] })).kind).toBe('image');
    const d = classifyShape(scene(rect({ fills: [imagePaint('abc')] })), MIXED, { ...settings, imageFills: 'rasterize' }, IDENTITY);
    expect(d).toMatchObject({ kind: 'raster', reasons: ['setting'] });
  });

  it('collects every applicable reason', () => {
    const d = shape(
      rect({
        fills: [solid(), radial()],
        cornerRadius: MIXED,
        topLeftRadius: 4,
        topRightRadius: 0,
        strokes: [linear()],
        blendMode: 'MULTIPLY',
        effects: [layerBlur(), dropShadow(), dropShadow()],
        relativeTransform: [
          [1, 0.3, 0],
          [0, 1, 0],
        ] as Matrix,
      }),
    );
    expect(d.kind).toBe('raster');
    expect(d.reasons.sort()).toEqual(['blend-mode', 'blur', 'effects', 'gradient', 'mixed-radii', 'multiple-fills', 'stroke', 'transform'].sort());
  });

  it('equal per-corner radii with mixed cornerRadius are uniform', () => {
    const d = shape(rect({ cornerRadius: MIXED, topLeftRadius: 6, topRightRadius: 6, bottomRightRadius: 6, bottomLeftRadius: 6 }));
    expect(d).toMatchObject({ kind: 'native', geometry: 'roundRect', radius: 6 });
  });

  it('paints nothing → none (mixed radii do not matter then)', () => {
    expect(shape(rect({ fills: [], cornerRadius: MIXED, topLeftRadius: 3 })).kind).toBe('none');
  });

  it('rotation and flips are native', () => {
    const d = shape(rect({ relativeTransform: placement(0, 0, -45, true) }));
    expect(d.kind).toBe('native');
    expect(d.transform.flipH).toBe(true);
    expect(d.transform.rotation).toBe(45);
  });

  it('frame backgrounds ignore blend / blur (container level) but not several shadows', () => {
    const f = frame({ fills: [solid('#ffffff')], blendMode: 'MULTIPLY', effects: [layerBlur()] });
    expect(shape(f, { frameBackground: true, ignoreStrokes: true }).kind).toBe('native');
    const g = frame({ fills: [solid('#ffffff')], effects: [dropShadow(), dropShadow()] });
    expect(shape(g, { frameBackground: true, ignoreStrokes: true })).toMatchObject({ kind: 'raster', reasons: ['effects'] });
  });
});

describe('ELLIPSE rules', () => {
  it('default arc native, arcs → vector', () => {
    expect(shape(ellipse(), { ellipse: true })).toMatchObject({ kind: 'native', geometry: 'ellipse' });
    const arc = ellipse({ arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 } });
    expect(hasDefaultArc(scene(arc))).toBe(false);
    expect(shape(arc, { ellipse: true })).toMatchObject({ kind: 'raster', reasons: ['vector'] });
    const donut = ellipse({ arcData: { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5 } });
    expect(shape(donut, { ellipse: true }).reasons).toEqual(['vector']);
  });
});

describe('LINE rules', () => {
  const lineOf = (props: Parameters<typeof line>[0]) => {
    const n = scene(line(props));
    return classifyLine(n, MIXED, relativeMatrix(IDENTITY, n));
  };

  it('endpoints → box + flips, caps, arrows, dash', () => {
    const d = lineOf({ x: 10, y: 20, width: 100, strokeCap: 'ARROW_LINES', dashPattern: [4, 4] });
    expect(d.kind).toBe('native');
    expect(d.transform).toEqual({ x: 10, y: 20, w: 100, h: 0, rotation: 0, flipH: false, flipV: false });
    expect(d.stroke).toMatchObject({ weight: 2, cap: 'none', startArrow: 'arrow', endArrow: 'arrow', dash: [4, 4] });
    expect(lineOf({ strokeCap: 'ROUND' }).stroke).toMatchObject({ cap: 'round', startArrow: 'none' });
    expect(lineOf({ strokeCap: 'TRIANGLE_FILLED' }).stroke?.startArrow).toBe('triangle');
    expect(lineOf({ strokeCap: 'ARROW_EQUILATERAL' }).stroke?.endArrow).toBe('triangle');
    expect(lineOf({ strokeCap: 'DIAMOND_FILLED' }).stroke?.endArrow).toBe('diamond');
    expect(lineOf({ strokeCap: 'CIRCLE_FILLED' }).stroke?.endArrow).toBe('oval');
  });

  it('direction: rotated lines become flipped boxes', () => {
    // 90° CCW: from (0, 100) up to (0, 0) → vertical, start at the bottom → flipV.
    expect(lineTransform(placement(0, 100, 90), 100)).toEqual({ x: 0, y: 0, w: 0, h: 100, rotation: 0, flipH: false, flipV: true });
    // 180°: from (100, 0) to (0, 0) → flipH.
    const t = lineTransform(placement(100, 0, 180), 100);
    expect(t).toMatchObject({ x: 0, w: 100, flipH: true, flipV: false });
    // -45° (clockwise 45°): diagonal down-right, no flips.
    expect(lineTransform(placement(0, 0, -45), Math.SQRT2 * 10)).toMatchObject({ w: 10, h: 10, flipH: false, flipV: false });
  });

  it('mixed caps, gradient stroke, blur → raster; no stroke → none', () => {
    expect(lineOf({ strokeCap: MIXED })).toMatchObject({ kind: 'raster', reasons: ['stroke'] });
    expect(lineOf({ strokes: [linear()] }).reasons).toEqual(['stroke']);
    expect(lineOf({ effects: [layerBlur()] }).reasons).toEqual(['blur']);
    expect(lineOf({ strokes: [] }).kind).toBe('none');
    expect(lineOf({ effects: [dropShadow()] }).shadow?.type).toBe('outer');
  });
});

describe('container rules', () => {
  const reasons = (n: ReturnType<typeof frame>) => containerRasterReasons(scene(n), MIXED, IDENTITY);

  it('plain containers are walked', () => {
    expect(reasons(frame({ children: [rect(), text()] }))).toEqual([]);
    expect(reasons(group({ children: [rect(), rect({ x: 200 })] }))).toEqual([]);
  });

  it('mask child → mask', () => {
    expect(reasons(group({ children: [rect({ isMask: true }), rect()] }))).toEqual(['mask']);
    expect(reasons(group({ children: [rect({ isMask: true, visible: false }), rect()] }))).toEqual([]);
  });

  it('blend mode, blur', () => {
    expect(reasons(group({ blendMode: 'MULTIPLY', children: [rect()] }))).toEqual(['blend-mode']);
    expect(reasons(group({ blendMode: 'NORMAL', children: [rect()] }))).toEqual([]);
    expect(reasons(frame({ effects: [{ type: 'BACKGROUND_BLUR', radius: 8, visible: true }], children: [rect()] }))).toEqual(['blur']);
  });

  it('shadows on groups / fill-less frames → effects; on filled frames → native background shadow', () => {
    expect(reasons(group({ effects: [dropShadow()], children: [rect()] }))).toEqual(['effects']);
    expect(reasons(frame({ effects: [dropShadow()], children: [rect()] }))).toEqual(['effects']);
    expect(reasons(frame({ fills: [solid('#ffffff')], effects: [dropShadow()], children: [rect()] }))).toEqual([]);
  });

  it('group opacity: only overlapping children (or the own fill under a child) need a raster', () => {
    expect(reasons(group({ opacity: 0.5, children: [rect({ width: 50 }), rect({ x: 100, width: 50 })] }))).toEqual([]);
    expect(reasons(group({ opacity: 0.5, children: [rect({ width: 50 }), rect({ x: 40, width: 50 })] }))).toEqual(['group-opacity']);
    expect(reasons(frame({ opacity: 0.5, fills: [solid('#ffffff')], width: 200, children: [rect({ width: 50 })] }))).toEqual(['group-opacity']);
    expect(reasons(frame({ opacity: 0.5, width: 200, children: [rect({ width: 50 })] }))).toEqual([]);
  });

  it('rotated clipping frame with overflowing children → clip', () => {
    expect(reasons(frame({ relativeTransform: placement(0, 0, 30), children: [rect({ x: 80, width: 50 })] }))).toEqual(['clip']);
    expect(reasons(frame({ relativeTransform: placement(0, 0, 30), children: [rect({ x: 10, width: 50, height: 50 })] }))).toEqual([]);
    expect(reasons(frame({ relativeTransform: placement(0, 0, 90), children: [rect({ x: 80, width: 50 })] }))).toEqual([]);
  });

  it('the slide root never rasterizes as a whole', () => {
    expect(containerRasterReasons(scene(frame({ blendMode: 'MULTIPLY', children: [rect({ isMask: true })] })), MIXED, IDENTITY, true)).toEqual([]);
  });

  it('overlap sweep', () => {
    expect(anyOverlap([{ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }])).toBe(false);
    expect(anyOverlap([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }])).toBe(true);
    expect(anyOverlap([{ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 20, w: 10, h: 10 }])).toBe(false);
  });
});

describe('icon-like containers', () => {
  const icon = (props: Parameters<typeof group>[0]) => isIconLike(scene(group({ width: 24, height: 24, ...props })), MIXED);

  it('only vector-like descendants, ≥1 vector leaf, small', () => {
    expect(icon({ children: [vector(), rect(), group({ children: [booleanOp({ children: [rect(), rect()] }), line()] })] })).toBe(true);
    expect(icon({ children: [rect(), ellipse()] })).toBe(false); // natively representable, no vector leaf
    expect(icon({ children: [vector(), text()] })).toBe(false);
    expect(icon({ children: [vector(), rect({ fills: [imagePaint('x')] })] })).toBe(false);
    expect(icon({ children: [vector(), vector({ visible: false }), text({ visible: false })] })).toBe(true);
  });

  it('size limit and container types', () => {
    const big = frame({ width: 1000, height: 10, children: [vector()] });
    expect(isIconLike(scene(big), MIXED)).toBe(false);
    expect(isIconLike(scene(frame({ width: 24, height: 24, children: [vector()] })), MIXED)).toBe(true);
    expect(isIconLike(scene(vector()), MIXED)).toBe(false);
  });
});
