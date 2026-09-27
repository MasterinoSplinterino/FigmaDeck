import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { shadowEffectXml, shadowGeometry } from '../../src/build/effects';
import { custDashXml, lnXml, reframeGradient, roundRectGeometryXml, strokeAlignedGeometry } from '../../src/build/shapes';
import type { LinearGradientFill } from '../../src/ir/types';
import { rgb, stroke, tf } from '../fixtures/ir-builders';

const wellFormed = (xml: string) =>
  XMLValidator.validate(`<r xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${xml}</r>`) === true;

describe('lnXml', () => {
  it('no stroke → <a:ln><a:noFill/></a:ln>', () => {
    expect(lnXml(null, 1, 1)).toBe('<a:ln><a:noFill/></a:ln>');
    expect(lnXml(stroke({ weight: 0 }), 1, 1)).toBe('<a:ln><a:noFill/></a:ln>');
  });

  it('solid stroke: width in EMU (scaled), fill, prstDash, join', () => {
    expect(lnXml(stroke({ weight: 2, color: rgb('112233') }), 0.5, 1)).toBe(
      `<a:ln w="12700"><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="${CONFIG.pptx.miterLimit}"/></a:ln>`,
    );
  });

  it('caps, custom dash, round join, alpha from color × opacity', () => {
    const xml = lnXml(stroke({ weight: 4, cap: 'round', dash: [12, 8], join: 'round', color: rgb('000000', 0.5) }), 1, 0.5);
    expect(xml).toBe(
      '<a:ln w="50800" cap="rnd"><a:solidFill><a:srgbClr val="000000"><a:alpha val="25000"/></a:srgbClr></a:solidFill>' +
        '<a:custDash><a:ds d="300000" sp="200000"/></a:custDash><a:round/></a:ln>',
    );
    expect(lnXml(stroke({ cap: 'square', join: 'bevel' }), 1, 1)).toMatch(/cap="sq".*<a:bevel\/>/);
    expect(wellFormed(xml)).toBe(true);
  });

  it('arrow heads only when asked (lines), in schema order after the join', () => {
    const s = stroke({ startArrow: 'oval', endArrow: 'triangle' });
    expect(lnXml(s, 1, 1)).not.toContain('End');
    const xml = lnXml(s, 1, 1, true);
    expect(xml).toMatch(/<a:miter[^>]*\/><a:headEnd type="oval"\/><a:tailEnd type="triangle"\/><\/a:ln>$/);
    expect(lnXml(stroke({ endArrow: 'arrow' }), 1, 1, true)).toContain('<a:tailEnd type="arrow"/>');
    expect(lnXml(stroke({ endArrow: 'diamond' }), 1, 1, true)).not.toContain('headEnd');
  });
});

describe('custDashXml', () => {
  it('dash / gap as % of the line width', () => {
    expect(custDashXml([6, 4, 2, 4], 2)).toBe('<a:custDash><a:ds d="300000" sp="200000"/><a:ds d="100000" sp="200000"/></a:custDash>');
  });
  it('odd patterns repeat (SVG semantics)', () => {
    expect(custDashXml([4], 2)).toBe('<a:custDash><a:ds d="200000" sp="200000"/></a:custDash>');
  });
  it('solid for empty / zero patterns or zero weight', () => {
    expect(custDashXml(null, 2)).toBeNull();
    expect(custDashXml([], 2)).toBeNull();
    expect(custDashXml([0, 0], 2)).toBeNull();
    expect(custDashXml([4, 4], 0)).toBeNull();
  });
  it('zero-length dashes (dots with round caps) stay positive', () => {
    expect(custDashXml([0, 8], 4)).toBe('<a:custDash><a:ds d="1" sp="200000"/></a:custDash>');
  });
});

describe('roundRectGeometryXml', () => {
  it('adj = radius / shorter side, clamped to 50 000', () => {
    expect(roundRectGeometryXml(24, 240, 160)).toContain('fmla="val 15000"');
    expect(roundRectGeometryXml(200, 240, 120)).toContain('fmla="val 50000"');
    expect(roundRectGeometryXml(-5, 240, 120)).toContain('fmla="val 0"');
    expect(roundRectGeometryXml(10, 0, 120)).toContain('fmla="val 0"');
  });
});

describe('strokeAlignedGeometry', () => {
  it('center: unchanged', () => {
    const t = tf(10, 10, 100, 50);
    expect(strokeAlignedGeometry(t, 8, stroke({ align: 'center', weight: 4 }))).toEqual({ transform: t, radius: 8 });
  });
  it('inside: shrinks by the weight keeping the center, radius − weight / 2', () => {
    const r = strokeAlignedGeometry(tf(10, 10, 100, 50), 8, stroke({ align: 'inside', weight: 4 }));
    expect(r.transform).toMatchObject({ x: 12, y: 12, w: 96, h: 46 });
    expect(r.radius).toBe(6);
  });
  it('outside: grows by the weight, radius + weight / 2', () => {
    const r = strokeAlignedGeometry(tf(10, 10, 100, 50, 30), 0, stroke({ align: 'outside', weight: 6 }));
    expect(r.transform).toMatchObject({ x: 7, y: 7, w: 106, h: 56, rotation: 30 });
    expect(r.radius).toBe(3);
  });
  it('never negative', () => {
    const r = strokeAlignedGeometry(tf(0, 0, 4, 4), 1, stroke({ align: 'inside', weight: 10 }));
    expect(r.transform.w).toBe(0);
    expect(r.radius).toBe(0);
  });
});

describe('reframeGradient', () => {
  it('keeps the gradient parameter at every absolute point', () => {
    const fill: LinearGradientFill = {
      type: 'linear-gradient',
      stops: [],
      gradientTransform: [
        [0.8, 0.3, 0.1],
        [-0.3, 0.8, 0.2],
      ],
    };
    const from = { x: 10, y: 20, w: 100, h: 50 };
    const to = { x: 7, y: 17, w: 106, h: 56 };
    const g = reframeGradient(fill, from, to);
    const t = (m: LinearGradientFill['gradientTransform'], box: typeof from, px: number, py: number) =>
      m[0][0] * ((px - box.x) / box.w) + m[0][1] * ((py - box.y) / box.h) + m[0][2];
    for (const [px, py] of [
      [10, 20],
      [60, 45],
      [113, 73],
      [0, 0],
    ]) {
      expect(t(g.gradientTransform, to, px, py)).toBeCloseTo(t(fill.gradientTransform, from, px, py), 12);
    }
  });
});

describe('shadows', () => {
  it('offset → distance + direction (clockwise, y down), blur and alpha', () => {
    const g = shadowGeometry({ type: 'outer', color: rgb('000000', 0.5), offsetX: 0, offsetY: 8, blur: 24, spread: 0 }, 1, 0.5);
    expect(g).toEqual({ blurRad: Math.round(24 * CONFIG.shadow.blurFactor * 12700), dist: 101600, dir: 5400000, alpha: 0.25 });
    const left = shadowGeometry({ type: 'outer', color: rgb('000000'), offsetX: -3, offsetY: -3, blur: 0, spread: 0 }, 2, 1);
    expect(left.dir).toBe(225 * 60000);
    expect(left.dist).toBe(Math.round(Math.hypot(3, 3) * 2 * 12700));
    expect(left.blurRad).toBe(0);
  });

  it('zero offset / zero blur are written as 0 (not pptxgenjs defaults)', () => {
    const xml = shadowEffectXml({ type: 'outer', color: rgb('FF0000'), offsetX: 0, offsetY: 0, blur: 0, spread: 0 }, 1, 1);
    expect(xml).toBe(
      '<a:effectLst><a:outerShdw blurRad="0" dist="0" dir="0" algn="ctr" rotWithShape="1"><a:srgbClr val="FF0000"/></a:outerShdw></a:effectLst>',
    );
  });

  it('inner shadows are closed with </a:innerShdw>', () => {
    const xml = shadowEffectXml({ type: 'inner', color: rgb('000000', 0.25), offsetX: 0, offsetY: 4, blur: 8, spread: 0 }, 1, 1);
    expect(xml).toMatch(/^<a:effectLst><a:innerShdw [^>]*>.*<\/a:innerShdw><\/a:effectLst>$/);
    expect(wellFormed(xml)).toBe(true);
  });
});
