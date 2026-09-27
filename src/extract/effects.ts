/**
 * Figma effects → one native shadow, or raster reasons.
 *
 * Native: at most one visible DROP_SHADOW / INNER_SHADOW with spread 0 and normal blend.
 * LAYER_BLUR / BACKGROUND_BLUR → `blur`; several shadows, spread ≠ 0, noise / texture / glass /
 * shader effects → `effects`.
 */
import type { RasterReason, Shadow } from '../ir/types';
import { clean } from './geometry';
import { colorOf, isNormalBlend } from './paints';

export interface EffectAnalysis {
  /** The single native shadow (null when there is none or it cannot be native). */
  shadow: Shadow | null;
  /** Number of visible shadows. */
  shadowCount: number;
  /** Visible layer / background blur. */
  hasBlur: boolean;
  /** Reasons the effects need rasterization (empty = native / none). */
  reasons: RasterReason[];
}

function isVisibleEffect(e: Effect): boolean {
  return (e as { visible?: boolean }).visible !== false;
}

export function analyzeEffects(effects: readonly Effect[]): EffectAnalysis {
  const reasons: RasterReason[] = [];
  const add = (r: RasterReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const shadows: Array<DropShadowEffect | InnerShadowEffect> = [];
  let hasBlur = false;
  for (const e of effects) {
    if (!isVisibleEffect(e)) continue;
    switch (e.type) {
      case 'DROP_SHADOW':
      case 'INNER_SHADOW':
        // A fully transparent shadow paints nothing.
        if (e.color.a > 0) shadows.push(e);
        break;
      case 'LAYER_BLUR':
      case 'BACKGROUND_BLUR':
        if (e.radius > 0) {
          hasBlur = true;
          add('blur');
        }
        break;
      default:
        // NOISE, TEXTURE, GLASS, SHADER and future effect types.
        add('effects');
    }
  }
  let shadow: Shadow | null = null;
  if (shadows.length > 1) add('effects');
  else if (shadows.length === 1) {
    const s = shadows[0];
    if ((s.spread ?? 0) !== 0 || !isNormalBlend(s.blendMode)) add('effects');
    else {
      shadow = {
        type: s.type === 'DROP_SHADOW' ? 'outer' : 'inner',
        color: colorOf(s.color),
        offsetX: clean(s.offset.x),
        offsetY: clean(s.offset.y),
        blur: clean(Math.max(0, s.radius)),
        spread: 0,
      };
    }
  }
  return { shadow: reasons.includes('effects') ? null : shadow, shadowCount: shadows.length, hasBlur, reasons };
}
