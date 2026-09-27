/**
 * Figma linear gradient → OOXML `<a:gradFill>` with `<a:lin ang scaled="0">`.
 *
 * Figma: `gradientTransform` M = [[m00, m01, m02], [m10, m11, m12]] maps the element's normalized,
 * unrotated box (u = px / w, v = py / h) into gradient space; the gradient parameter is
 *   t(u, v) = m00·u + m01·v + m02            (stop positions are values of t).
 * In pixel space the gradient of t is g = (m00 / w, m01 / h), so colors change along g.
 *
 * OOXML (`scaled="0"`): the gradient line has angle `ang` (clockwise, y down — same as atan2 in
 * screen coordinates), passes through the box center C = (w/2, h/2) and has the length of the box
 * projected onto it, L = |w·cos(ang)| + |h·sin(ang)|; stop position q ∈ [0, 1] is measured along it.
 * A point at q has t = t(C) + (q − 0.5)·L·|g|, hence Figma stop f maps to
 *   q = (f − t(C)) / (L·|g|) + 0.5.
 * Stops outside [0, 1] are clipped, with interpolated boundary colors inserted (both Figma and
 * PowerPoint pad with the end colors, so the look is preserved).
 */
import { CONFIG } from '../config';
import type { Color, GradientStop, LinearGradientFill } from '../ir/types';
import { effectiveAlpha, solidFillXml, srgbClrXml } from './color';
import { clamp, degreesToOoxmlAngle } from './units';

export interface OoxmlGradientStop {
  /** 0..100 000 (1/1000 %). */
  pos: number;
  color: Color;
  /** Final alpha 0..1 (stop alpha × element opacity). */
  alpha: number;
}

export type GradientConversion =
  | { kind: 'solid'; color: Color; alpha: number }
  | {
      kind: 'linear';
      /** Degrees, clockwise, [0, 360). */
      angleDeg: number;
      /** OOXML angle (1/60 000 °). */
      ang: number;
      stops: OoxmlGradientStop[];
    };

const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: Color, b: Color, t: number): Color {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t), a: lerp(a.a, b.a, t) };
}

/** Color at gradient-line position q of stops sorted by q; padded with the end colors outside. */
function colorAt(stops: ReadonlyArray<{ q: number; color: Color }>, q: number): Color {
  if (q <= stops[0].q) return stops[0].color;
  const last = stops[stops.length - 1];
  if (q >= last.q) return last.color;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (q <= b.q) {
      const span = b.q - a.q;
      return span > 0 ? lerpColor(a.color, b.color, (q - a.q) / span) : b.color;
    }
  }
  return last.color;
}

/**
 * Convert a Figma linear gradient on a `w × h` px box (unrotated) into OOXML terms.
 * `opacity` is the element opacity (multiplied into every stop's alpha).
 */
export function convertLinearGradient(
  fill: LinearGradientFill,
  w: number,
  h: number,
  opacity: number,
): GradientConversion {
  const sorted: GradientStop[] = [...(fill.stops ?? [])].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) return { kind: 'solid', color: TRANSPARENT, alpha: 0 };
  const solid = (c: Color): GradientConversion => ({ kind: 'solid', color: c, alpha: effectiveAlpha(c, opacity) });
  if (sorted.length === 1 || !(w > 0) || !(h > 0)) return solid(sorted[0].color);

  const [[m00, m01, m02]] = fill.gradientTransform;
  const gx = m00 / w;
  const gy = m01 / h;
  const gLen = Math.hypot(gx, gy);
  if (!Number.isFinite(gLen) || gLen * Math.max(w, h) < CONFIG.gradient.degenerateLength) return solid(sorted[0].color);

  const rad = Math.atan2(gy, gx);
  const angleDeg = ((((rad * 180) / Math.PI) % 360) + 360) % 360;
  const tCenter = m00 * 0.5 + m01 * 0.5 + m02;
  const lineLength = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const span = lineLength * gLen; // gradient units covered by the OOXML gradient line

  const mapped = sorted.map((s) => ({ q: (s.position - tCenter) / span + 0.5, color: s.color }));
  const eps = CONFIG.gradient.stopEpsilon;

  const out: Array<{ q: number; color: Color }> = [];
  const inside = mapped.filter((s) => s.q >= -eps && s.q <= 1 + eps).map((s) => ({ q: clamp(s.q, 0, 1), color: s.color }));
  if (mapped[0].q < -eps && !(inside.length > 0 && inside[0].q <= eps)) out.push({ q: 0, color: colorAt(mapped, 0) });
  out.push(...inside);
  const lastInside = inside[inside.length - 1];
  if (mapped[mapped.length - 1].q > 1 + eps && !(lastInside && lastInside.q >= 1 - eps)) {
    out.push({ q: 1, color: colorAt(mapped, 1) });
  }
  // OOXML needs at least two stops.
  if (out.length === 1) out.push({ q: out[0].q < 0.5 ? 1 : 0, color: out[0].color });
  out.sort((a, b) => a.q - b.q);

  return {
    kind: 'linear',
    angleDeg,
    ang: degreesToOoxmlAngle(angleDeg),
    stops: out.map((s) => ({
      pos: clamp(Math.round(s.q * 100000), 0, 100000),
      color: s.color,
      alpha: effectiveAlpha(s.color, opacity),
    })),
  };
}

/** `<a:gradFill>` (or `<a:solidFill>` for degenerate gradients) for a converted gradient. */
export function gradientFillXml(g: GradientConversion): string {
  if (g.kind === 'solid') return solidFillXml(g.color, g.alpha);
  const stops = g.stops.map((s) => `<a:gs pos="${s.pos}">${srgbClrXml(s.color, s.alpha)}</a:gs>`).join('');
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${g.ang}" scaled="0"/></a:gradFill>`;
}
