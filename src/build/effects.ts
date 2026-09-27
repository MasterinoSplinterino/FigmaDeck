/**
 * Figma DROP_SHADOW / INNER_SHADOW → `<a:effectLst>` with `<a:outerShdw>` / `<a:innerShdw>`.
 *
 * Written by post/ instead of pptxgenjs' `shadow` option: pptxgenjs 4.0.1 closes inner shadows on
 * shapes with `</a:outerShdw>` (malformed XML) and replaces 0 values with its defaults
 * (`blur || 8`, `offset || 4`, `angle || 270`, `opacity || 0.75`), so a 0-offset or 0-blur shadow
 * would come out wrong.
 */
import { CONFIG } from '../config';
import type { Shadow } from '../ir/types';
import { effectiveAlpha, srgbClrXml } from './color';
import { degreesToOoxmlAngle, ptToEmu } from './units';

export interface ShadowGeometry {
  /** Blur radius, EMU. */
  blurRad: number;
  /** Offset distance, EMU. */
  dist: number;
  /** Offset direction, OOXML angle (clockwise from +x, 1/60 000 °). */
  dir: number;
  /** 0..1 */
  alpha: number;
}

/** Shadow → OOXML numbers. `scale` = slide scale (px → pt), `opacity` = element opacity. */
export function shadowGeometry(shadow: Shadow, scale: number, opacity: number): ShadowGeometry {
  const offset = Math.hypot(shadow.offsetX, shadow.offsetY);
  const deg = offset > 0 ? (Math.atan2(shadow.offsetY, shadow.offsetX) * 180) / Math.PI : 0;
  return {
    blurRad: Math.min(CONFIG.ooxml.maxInt32, Math.max(0, ptToEmu(Math.max(0, shadow.blur) * CONFIG.shadow.blurFactor * scale))),
    dist: Math.min(CONFIG.ooxml.maxInt32, Math.max(0, ptToEmu(offset * scale))),
    dir: degreesToOoxmlAngle(deg),
    alpha: effectiveAlpha(shadow.color, opacity),
  };
}

/**
 * `<a:effectLst>` for one shadow. Figma renders effects in the layer's local space, so the shadow
 * rotates with the shape (`rotWithShape="1"`).
 */
export function shadowEffectXml(shadow: Shadow, scale: number, opacity: number): string {
  const g = shadowGeometry(shadow, scale, opacity);
  const clr = srgbClrXml(shadow.color, g.alpha);
  if (shadow.type === 'inner') {
    return `<a:effectLst><a:innerShdw blurRad="${g.blurRad}" dist="${g.dist}" dir="${g.dir}">${clr}</a:innerShdw></a:effectLst>`;
  }
  return (
    `<a:effectLst><a:outerShdw blurRad="${g.blurRad}" dist="${g.dist}" dir="${g.dir}" algn="ctr" rotWithShape="1">` +
    `${clr}</a:outerShdw></a:effectLst>`
  );
}
