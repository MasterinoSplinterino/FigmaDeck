import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { alphaToTransparency, effectiveAlpha, hexColor, srgbClrXml } from '../../src/build/color';
import { fontSizeToSz, letterSpacingToSpc } from '../../src/build/text';
import {
  EMU_PER_INCH,
  EMU_PER_PT,
  clamp,
  degreesToOoxmlAngle,
  emuArg,
  fractionToOoxmlPercent,
  letterSpacingPx,
  lineHeightPx,
  ptToCentipoints,
  ptToEmu,
} from '../../src/build/units';

/** pptxgenjs 4.0.1 `getSmartParseNumber` for numbers: < 100 → inches, >= 100 → EMU as is. */
function pptxgenjsParse(v: number): number {
  return v < 100 ? Math.round(EMU_PER_INCH * v) : v;
}

describe('EMU / pt', () => {
  it('1 px = 1 pt = 12 700 EMU, 72 pt = 1 inch', () => {
    expect(EMU_PER_PT).toBe(12700);
    expect(ptToEmu(1)).toBe(12700);
    expect(ptToEmu(72)).toBe(EMU_PER_INCH);
    expect(ptToEmu(1920)).toBe(24384000);
    expect(ptToEmu(0.5)).toBe(6350);
  });

  it('56 inches = 4032 pt = 51 206 400 EMU (PowerPoint maximum)', () => {
    expect(ptToEmu(CONFIG.slide.maxInches * 72)).toBe(51206400);
  });

  it('centipoints and OOXML percentages are rounded integers', () => {
    expect(ptToCentipoints(64)).toBe(6400);
    expect(ptToCentipoints(-0.27)).toBe(-27);
    expect(fractionToOoxmlPercent(1)).toBe(100000);
    expect(fractionToOoxmlPercent(0.123456)).toBe(12346);
  });

  it('angles are normalized to [0, 360°) in 1/60 000 degree', () => {
    expect(degreesToOoxmlAngle(0)).toBe(0);
    expect(degreesToOoxmlAngle(90)).toBe(5400000);
    expect(degreesToOoxmlAngle(-90)).toBe(16200000);
    expect(degreesToOoxmlAngle(360)).toBe(0);
    expect(degreesToOoxmlAngle(725)).toBe(300000);
    expect(degreesToOoxmlAngle(359.9999999)).toBe(0);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe('emuArg (pptxgenjs coordinate encoding)', () => {
  it('round-trips every integer EMU value exactly through pptxgenjs parsing', () => {
    const values = [0, 1, 50, 99, 100, 101, 12700, 914400, 51206400, 91440000, 200 * EMU_PER_INCH, -1, -5000, -91440000, 1234567.4];
    for (const v of values) expect(pptxgenjsParse(emuArg(v))).toBe(Math.round(v));
  });

  it('passes large values as EMU (pptxgenjs would misread >= 100 inches)', () => {
    expect(emuArg(150 * EMU_PER_INCH)).toBe(150 * EMU_PER_INCH);
    expect(emuArg(99)).toBeCloseTo(99 / EMU_PER_INCH, 12);
  });
});

describe('Figma line height → px', () => {
  it('PIXELS as is', () => {
    expect(lineHeightPx({ fontSize: 16, lineHeight: { unit: 'PIXELS', value: 22 } })).toBe(22);
  });
  it('PERCENT of the font size', () => {
    expect(lineHeightPx({ fontSize: 21, lineHeight: { unit: 'PERCENT', value: 110 } })).toBeCloseTo(23.1, 10);
  });
  it('AUTO = font size × CONFIG.text.autoLineHeight', () => {
    expect(lineHeightPx({ fontSize: 20, lineHeight: { unit: 'AUTO' } })).toBeCloseTo(20 * CONFIG.text.autoLineHeight, 10);
  });
});

describe('Figma letter spacing → px / spc', () => {
  it('PERCENT: −3 % of 9 px = −0.27 → spc −27 (reference Deck value)', () => {
    const s = { fontSize: 9, letterSpacing: { unit: 'PERCENT' as const, value: -3 } };
    expect(letterSpacingPx(s)).toBeCloseTo(-0.27, 10);
    expect(letterSpacingToSpc(s, 1)).toBe(-27);
  });
  it('PIXELS as is, scaled by the slide scale', () => {
    const s = { fontSize: 20, letterSpacing: { unit: 'PIXELS' as const, value: 1.5 } };
    expect(letterSpacingToSpc(s, 1)).toBe(150);
    expect(letterSpacingToSpc(s, 0.5)).toBe(75);
  });
  it('clamps to the OOXML range', () => {
    expect(letterSpacingToSpc({ fontSize: 10, letterSpacing: { unit: 'PIXELS', value: 1e6 } }, 1)).toBe(400000);
  });
});

describe('font size → sz', () => {
  it('1 px = 1 pt, 1/100 pt units, scaled', () => {
    expect(fontSizeToSz(64, 1)).toBe(6400);
    expect(fontSizeToSz(64, 4032 / 4992)).toBe(5169);
    expect(fontSizeToSz(9, 1)).toBe(900);
  });
  it('clamps to 1…4000 pt', () => {
    expect(fontSizeToSz(0.2, 1)).toBe(100);
    expect(fontSizeToSz(10000, 1)).toBe(400000);
    expect(fontSizeToSz(Number.NaN, 1)).toBe(100);
  });
});

describe('colors', () => {
  it('hex is RRGGBB uppercase without #', () => {
    expect(hexColor({ r: 1, g: 0, b: 0 })).toBe('FF0000');
    expect(hexColor({ r: 0x21 / 255, g: 0xa0 / 255, b: 0x38 / 255 })).toBe('21A038');
    expect(hexColor({ r: 2, g: -1, b: Number.NaN })).toBe('FF0000');
  });
  it('alpha = color alpha × layer opacity', () => {
    expect(effectiveAlpha({ a: 0.5 }, 0.5)).toBeCloseTo(0.25, 10);
    expect(effectiveAlpha({ a: 1 }, 1)).toBe(1);
    expect(alphaToTransparency(0.25)).toBeCloseTo(75, 10);
  });
  it('srgbClr writes <a:alpha> only below 100 %', () => {
    expect(srgbClrXml({ r: 0, g: 0, b: 0 }, 1)).toBe('<a:srgbClr val="000000"/>');
    expect(srgbClrXml({ r: 0, g: 0, b: 0 }, 0.4)).toBe('<a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr>');
  });
});
