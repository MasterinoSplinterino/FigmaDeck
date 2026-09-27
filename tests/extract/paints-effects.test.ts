import { describe, expect, it } from 'vitest';
import { analyzeEffects } from '../../src/extract/effects';
import { analyzeFills, analyzeStrokes, linearGradient, solidColor, uniformStrokeWeight, visiblePaints } from '../../src/extract/paints';
import { MIXED, dropShadow, imagePaint, innerShadow, layerBlur, linear, radial, rect, scene, solid } from '../helpers/figma-mocks';

const settings = { nativeGradients: true };

describe('paints', () => {
  it('folds paint opacity into alpha', () => {
    expect(solidColor(solid('#ff8000', 0.5) as SolidPaint)).toEqual({ r: 1, g: 0.501961, b: 0, a: 0.5 });
  });

  it('filters invisible paints', () => {
    const paints = [solid('#000000', 0), solid('#ffffff', 1, { visible: false }), solid('#123456')];
    expect(visiblePaints(paints)).toHaveLength(1);
    expect(visiblePaints('mixed')).toEqual([]);
  });

  it('linear gradient → IR with stop alpha × paint opacity and the raw transform', () => {
    const g = linearGradient(linear([[0, '#ff0000', 1], [1, '#0000ff', 0.5]], 0.5) as GradientPaint);
    expect(g.type).toBe('linear-gradient');
    expect(g.stops).toEqual([
      { position: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 0.25 } },
    ]);
    expect(g.gradientTransform).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it('analyzeFills: none / solid / linear / image / raster reasons', () => {
    expect(analyzeFills([], settings)).toEqual({ kind: 'none' });
    expect(analyzeFills([solid('#ffffff')], settings).kind).toBe('native');
    expect(analyzeFills([linear()], settings)).toMatchObject({ kind: 'native', fill: { type: 'linear-gradient' } });
    expect(analyzeFills([linear()], { nativeGradients: false })).toEqual({ kind: 'raster', reasons: ['gradient'] });
    expect(analyzeFills([radial()], settings)).toEqual({ kind: 'raster', reasons: ['gradient'] });
    expect(analyzeFills([imagePaint('h')], settings).kind).toBe('image');
    expect(analyzeFills([solid(), radial()], settings)).toEqual({ kind: 'raster', reasons: ['multiple-fills', 'gradient'] });
    expect(analyzeFills([solid('#000000', 1, { blendMode: 'MULTIPLY' })], settings)).toEqual({ kind: 'raster', reasons: ['blend-mode'] });
    expect(analyzeFills([{ type: 'VIDEO', visible: true } as unknown as Paint], settings)).toEqual({ kind: 'raster', reasons: ['image-fill-mode'] });
  });
});

describe('strokes', () => {
  const sides2 = { strokeTopWeight: 2, strokeRightWeight: 2, strokeBottomWeight: 2, strokeLeftWeight: 2 };
  const mk = (props: Record<string, unknown>) => scene(rect({ strokes: [solid('#0000ff')], strokeWeight: 2, ...sides2, ...props }));

  it('single uniform solid stroke is native', () => {
    const r = analyzeStrokes(mk({ strokeAlign: 'OUTSIDE', dashPattern: [4, 2], strokeJoin: 'ROUND', strokeTopWeight: 2, strokeRightWeight: 2, strokeBottomWeight: 2, strokeLeftWeight: 2 }), MIXED);
    expect(r).toEqual({
      kind: 'native',
      stroke: {
        color: { r: 0, g: 0, b: 1, a: 1 },
        weight: 2,
        align: 'outside',
        dash: [4, 2],
        cap: 'none',
        join: 'round',
        startArrow: 'none',
        endArrow: 'none',
      },
    });
  });

  it('no visible stroke / zero weight → none', () => {
    expect(analyzeStrokes(scene(rect()), MIXED)).toEqual({ kind: 'none' });
    expect(analyzeStrokes(mk({ strokeWeight: 0, strokeTopWeight: 0, strokeRightWeight: 0, strokeBottomWeight: 0, strokeLeftWeight: 0 }), MIXED)).toEqual({ kind: 'none' });
  });

  it('per-side weights, gradient, several strokes, brushes → stroke', () => {
    expect(analyzeStrokes(mk({ strokeWeight: MIXED, strokeTopWeight: 1, strokeRightWeight: 2, strokeBottomWeight: 1, strokeLeftWeight: 1 }), MIXED)).toEqual({ kind: 'raster', reasons: ['stroke'] });
    expect(analyzeStrokes(mk({ strokes: [linear()] }), MIXED)).toEqual({ kind: 'raster', reasons: ['stroke'] });
    expect(analyzeStrokes(mk({ strokes: [solid(), solid()] }), MIXED)).toEqual({ kind: 'raster', reasons: ['stroke'] });
    expect(analyzeStrokes(mk({ complexStrokeProperties: { type: 'BRUSH' } }), MIXED)).toEqual({ kind: 'raster', reasons: ['stroke'] });
    expect(analyzeStrokes(mk({ variableWidthStrokeProperties: { widthProfile: 'WEDGE' } }), MIXED)).toEqual({ kind: 'raster', reasons: ['stroke'] });
    expect(analyzeStrokes(mk({ strokes: [solid('#000000', 1, { blendMode: 'SCREEN' })] }), MIXED)).toEqual({ kind: 'raster', reasons: ['blend-mode'] });
  });

  it('uniform weight: mixed with equal sides is uniform', () => {
    expect(uniformStrokeWeight(mk({ strokeWeight: MIXED, strokeTopWeight: 3, strokeRightWeight: 3, strokeBottomWeight: 3, strokeLeftWeight: 3 }), MIXED)).toBe(3);
    expect(uniformStrokeWeight(scene(rect({ strokeWeight: 4, strokeTopWeight: undefined })), MIXED)).toBe(4);
  });
});

describe('effects', () => {
  it('one drop shadow with spread 0 → native outer shadow', () => {
    expect(analyzeEffects([dropShadow({ offset: { x: 2, y: 3 }, radius: 6 })])).toEqual({
      shadow: { type: 'outer', color: { r: 0, g: 0, b: 0, a: 0.25 }, offsetX: 2, offsetY: 3, blur: 6, spread: 0 },
      shadowCount: 1,
      hasBlur: false,
      reasons: [],
    });
    expect(analyzeEffects([innerShadow()]).shadow?.type).toBe('inner');
  });

  it('several shadows, spread, blend → effects; blur → blur; others → effects', () => {
    expect(analyzeEffects([dropShadow(), dropShadow()]).reasons).toEqual(['effects']);
    expect(analyzeEffects([dropShadow({ spread: 2 })])).toMatchObject({ shadow: null, reasons: ['effects'] });
    expect(analyzeEffects([dropShadow({ blendMode: 'MULTIPLY' })]).reasons).toEqual(['effects']);
    expect(analyzeEffects([layerBlur()])).toMatchObject({ hasBlur: true, reasons: ['blur'] });
    expect(analyzeEffects([{ type: 'BACKGROUND_BLUR', radius: 10, visible: true } as Effect]).reasons).toEqual(['blur']);
    expect(analyzeEffects([{ type: 'NOISE', visible: true } as unknown as Effect]).reasons).toEqual(['effects']);
  });

  it('ignores invisible / transparent / zero effects', () => {
    expect(analyzeEffects([dropShadow({ visible: false }), layerBlur(0), dropShadow({ color: { r: 0, g: 0, b: 0, a: 0 } })])).toEqual({
      shadow: null,
      shadowCount: 0,
      hasBlur: false,
      reasons: [],
    });
  });
});
