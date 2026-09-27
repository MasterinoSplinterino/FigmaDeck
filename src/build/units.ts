/**
 * Unit conversions for the builder.
 *
 *   Figma px ──× slide scale──▶ pt ──× 12 700──▶ EMU
 *
 * 1 Figma px = 1 pt before scaling (slide inches = px / 72). Every length that ends up in the PPTX goes
 * through the slide's scale factor (`SlidePlacement.scale`, see layout.ts).
 */
import { CONFIG } from '../config';
import type { FigmaLetterSpacing, FigmaLineHeight } from '../ir/types';

export const EMU_PER_PT = CONFIG.units.emuPerPt;
export const EMU_PER_INCH = CONFIG.units.emuPerInch;
export const PT_PER_INCH = CONFIG.units.pxPerInch;

/** OOXML angle unit: 1/60 000 degree. */
export const OOXML_DEGREE = 60000;
/** OOXML percentage unit: 1/1000 percent (100 % = 100 000). */
export const OOXML_PERCENT = 1000;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** pt → EMU (integer). */
export function ptToEmu(pt: number): number {
  return Math.round(pt * EMU_PER_PT);
}

/** pt → OOXML "hundredths of a point" (font size, `spc`, `spcPts`), integer. */
export function ptToCentipoints(pt: number): number {
  return Math.round(pt * 100);
}

/** Fraction (1 = 100 %) → OOXML percentage (100 000 = 100 %), integer. */
export function fractionToOoxmlPercent(fraction: number): number {
  return Math.round(fraction * 100 * OOXML_PERCENT);
}

/** Degrees → OOXML angle (1/60 000 °), normalized to [0, 360°). */
export function degreesToOoxmlAngle(degrees: number): number {
  const d = ((degrees % 360) + 360) % 360;
  const v = Math.round(d * OOXML_DEGREE);
  return v >= 360 * OOXML_DEGREE ? 0 : v;
}

/**
 * Encode an EMU value for a pptxgenjs coordinate option (x / y / w / h, sizing x / y / w / h).
 *
 * pptxgenjs 4.0.1 (`getSmartParseNumber`) treats numbers < 100 as INCHES and numbers >= 100 as EMU.
 * Passing inches only breaks for values >= 100 in (an element far off the slide, the full size of a
 * heavily cropped picture). This encoding is exact for every integer EMU value: values >= 100 are passed
 * as EMU, smaller (and negative) values as inches, which pptxgenjs converts back with `round(in × 914400)`.
 */
export function emuArg(emu: number): number {
  const e = Math.round(emu);
  return e >= 100 ? e : e / EMU_PER_INCH;
}

/** Figma line height of a style → px (before slide scaling). */
export function lineHeightPx(style: { fontSize: number; lineHeight: FigmaLineHeight }): number {
  const lh = style.lineHeight;
  switch (lh.unit) {
    case 'PIXELS':
      return lh.value;
    case 'PERCENT':
      return (style.fontSize * lh.value) / 100;
    case 'AUTO':
    default:
      return style.fontSize * CONFIG.text.autoLineHeight;
  }
}

/** Figma letter spacing of a style → px (before slide scaling). */
export function letterSpacingPx(style: { fontSize: number; letterSpacing: FigmaLetterSpacing }): number {
  const ls = style.letterSpacing;
  return ls.unit === 'PERCENT' ? (style.fontSize * ls.value) / 100 : ls.value;
}
