/**
 * IR colors (0..1 channels, Figma convention) → OOXML / pptxgenjs color values.
 */
import type { Color } from '../ir/types';
import { clamp, fractionToOoxmlPercent } from './units';

/** `RRGGBB`, uppercase, no `#` (the only format pptxgenjs and OOXML `srgbClr` accept). */
export function hexColor(c: Pick<Color, 'r' | 'g' | 'b'>): string {
  const ch = (v: number) =>
    clamp(Math.round((Number.isFinite(v) ? v : 0) * 255), 0, 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  return ch(c.r) + ch(c.g) + ch(c.b);
}

/** Effective alpha 0..1 of a paint: color alpha × layer opacity. */
export function effectiveAlpha(color: Pick<Color, 'a'>, opacity: number): number {
  const a = (Number.isFinite(color.a) ? color.a : 1) * (Number.isFinite(opacity) ? opacity : 1);
  return clamp(a, 0, 1);
}

/** Alpha 0..1 → pptxgenjs `transparency` 0..100 (percent). */
export function alphaToTransparency(alpha: number): number {
  return clamp((1 - alpha) * 100, 0, 100);
}

/** `<a:srgbClr val="RRGGBB">` with an `<a:alpha>` child when the alpha is below 100 %. */
export function srgbClrXml(color: Pick<Color, 'r' | 'g' | 'b'>, alpha: number): string {
  const val = hexColor(color);
  const a = fractionToOoxmlPercent(clamp(alpha, 0, 1));
  return a < 100000 ? `<a:srgbClr val="${val}"><a:alpha val="${a}"/></a:srgbClr>` : `<a:srgbClr val="${val}"/>`;
}

/** `<a:solidFill>` of a color with the given alpha. */
export function solidFillXml(color: Pick<Color, 'r' | 'g' | 'b'>, alpha: number): string {
  return `<a:solidFill>${srgbClrXml(color, alpha)}</a:solidFill>`;
}
