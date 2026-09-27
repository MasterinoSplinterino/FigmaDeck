/**
 * Figma paints → IR fills / strokes, with the reasons a paint cannot be written natively.
 *
 * Figma notes:
 * - `fills` / `strokes` arrays are painted bottom → top (the last paint is on top).
 * - Paint `opacity` is separate from the color (RGB); the IR folds it into `Color.a`.
 * - A paint is invisible when `visible === false` or `opacity === 0`.
 */
import type { Color, Fill, LinearGradientFill, RasterReason, Stroke } from '../ir/types';
import type { ExportSettings } from '../shared/settings';
import { clean } from './geometry';
import { strokesOf } from './node-props';

export function isVisiblePaint(p: Paint): boolean {
  return p.visible !== false && (p.opacity ?? 1) > 0;
}

export function visiblePaints(paints: readonly Paint[] | 'mixed' | undefined): Paint[] {
  if (!paints || paints === 'mixed') return [];
  return paints.filter(isVisiblePaint);
}

/** NORMAL and PASS_THROUGH (groups) composite like PowerPoint does. `undefined` = default (normal). */
export function isNormalBlend(mode: BlendMode | undefined): boolean {
  return mode === undefined || mode === 'NORMAL' || mode === 'PASS_THROUGH';
}

export function colorOf(rgb: RGB | RGBA, alpha = 1): Color {
  const a = 'a' in rgb && typeof rgb.a === 'number' ? rgb.a : 1;
  return { r: clean(rgb.r), g: clean(rgb.g), b: clean(rgb.b), a: clean(a * alpha) };
}

/** SOLID paint → color with the paint opacity folded into alpha. */
export function solidColor(p: SolidPaint): Color {
  return colorOf(p.color, p.opacity ?? 1);
}

/** GRADIENT_LINEAR → IR (stop alpha × paint opacity; transform passed through). */
export function linearGradient(p: GradientPaint): LinearGradientFill {
  const opacity = p.opacity ?? 1;
  return {
    type: 'linear-gradient',
    stops: p.gradientStops.map((s) => ({ position: clean(s.position), color: colorOf(s.color, opacity) })),
    gradientTransform: [
      [p.gradientTransform[0][0], p.gradientTransform[0][1], p.gradientTransform[0][2]],
      [p.gradientTransform[1][0], p.gradientTransform[1][1], p.gradientTransform[1][2]],
    ],
  };
}

/** Why a single paint cannot be a native fill (empty = it can). IMAGE is handled by images.ts. */
export function paintReasons(p: Paint, settings: Pick<ExportSettings, 'nativeGradients'>): RasterReason[] {
  const reasons: RasterReason[] = [];
  if (!isNormalBlend(p.blendMode)) reasons.push('blend-mode');
  switch (p.type) {
    case 'SOLID':
    case 'IMAGE':
      break;
    case 'GRADIENT_LINEAR':
      if (!settings.nativeGradients) reasons.push('gradient');
      break;
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND':
      reasons.push('gradient');
      break;
    case 'VIDEO':
    case 'PATTERN':
      reasons.push('image-fill-mode');
      break;
    default:
      // SHADER and future paint types.
      reasons.push('effects');
  }
  return reasons;
}

export type FillAnalysis =
  | { kind: 'none' }
  | { kind: 'native'; fill: Fill }
  | { kind: 'image'; paint: ImagePaint }
  | { kind: 'raster'; reasons: RasterReason[] };

/** Visible fills of a shape / frame background → one native fill, one image, nothing, or raster reasons. */
export function analyzeFills(
  fills: readonly Paint[] | 'mixed',
  settings: Pick<ExportSettings, 'nativeGradients'>,
): FillAnalysis {
  const visible = visiblePaints(fills);
  if (visible.length === 0) return { kind: 'none' };
  if (visible.length > 1) {
    const reasons: RasterReason[] = ['multiple-fills'];
    for (const p of visible) for (const r of paintReasons(p, settings)) if (!reasons.includes(r)) reasons.push(r);
    return { kind: 'raster', reasons };
  }
  const p = visible[0];
  const reasons = paintReasons(p, settings);
  if (reasons.length > 0) return { kind: 'raster', reasons };
  if (p.type === 'SOLID') return { kind: 'native', fill: { type: 'solid', color: solidColor(p) } };
  if (p.type === 'GRADIENT_LINEAR') return { kind: 'native', fill: linearGradient(p) };
  if (p.type === 'IMAGE') return { kind: 'image', paint: p };
  return { kind: 'raster', reasons: ['effects'] };
}

export type StrokeAnalysis =
  | { kind: 'none' }
  | { kind: 'native'; stroke: Stroke }
  | { kind: 'raster'; reasons: RasterReason[] };

type StrokeProps = {
  strokeWeight?: unknown;
  strokeTopWeight?: unknown;
  strokeRightWeight?: unknown;
  strokeBottomWeight?: unknown;
  strokeLeftWeight?: unknown;
  strokeAlign?: unknown;
  strokeJoin?: unknown;
  strokeCap?: unknown;
  dashPattern?: unknown;
  complexStrokeProperties?: { type?: string } | null;
  variableWidthStrokeProperties?: { widthProfile?: string } | null;
};

/**
 * Uniform stroke weight in px, `null` when the sides differ (per-side weights), 0 for no stroke.
 * `strokeWeight` is `figma.mixed` when individual side weights differ.
 */
export function uniformStrokeWeight(node: SceneNode, mixed: symbol): number | null {
  const n = node as unknown as StrokeProps;
  const sides = [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight];
  const hasSides = sides.every((s) => typeof s === 'number');
  if (typeof n.strokeWeight === 'number' && n.strokeWeight !== (mixed as unknown)) {
    if (hasSides && !(sides as number[]).every((s) => Math.abs(s - (n.strokeWeight as number)) < 1e-6)) return null;
    return Math.max(0, n.strokeWeight);
  }
  if (hasSides) {
    const s = sides as number[];
    return s.every((v) => Math.abs(v - s[0]) < 1e-6) ? Math.max(0, s[0]) : null;
  }
  return null;
}

const ALIGN: Record<string, Stroke['align']> = { CENTER: 'center', INSIDE: 'inside', OUTSIDE: 'outside' };
const JOIN: Record<string, Stroke['join']> = { MITER: 'miter', BEVEL: 'bevel', ROUND: 'round' };
const CAP: Record<string, Stroke['cap']> = { NONE: 'none', ROUND: 'round', SQUARE: 'square' };

/**
 * Visible strokes of a node → one native stroke, nothing, or raster reasons.
 * Native: exactly one visible SOLID stroke, normal blend, uniform weight, basic (non-brush,
 * non-variable-width) geometry. Line ends (arrows, caps) are resolved by the LINE mapping.
 */
export function analyzeStrokes(node: SceneNode, mixed: symbol): StrokeAnalysis {
  const visible = visiblePaints(strokesOf(node));
  if (visible.length === 0) return { kind: 'none' };
  const n = node as unknown as StrokeProps;
  const weight = uniformStrokeWeight(node, mixed);
  if (weight === 0) return { kind: 'none' };
  const reasons: RasterReason[] = [];
  if (visible.length > 1) reasons.push('stroke');
  const p = visible[visible.length - 1];
  if (p.type !== 'SOLID' && !reasons.includes('stroke')) reasons.push('stroke');
  if (visible.some((s) => !isNormalBlend(s.blendMode))) reasons.push('blend-mode');
  if (weight === null && !reasons.includes('stroke')) reasons.push('stroke');
  const complexType = n.complexStrokeProperties?.type;
  const widthProfile = n.variableWidthStrokeProperties?.widthProfile;
  if (
    ((complexType && complexType !== 'BASIC') || (widthProfile && widthProfile !== 'UNIFORM')) &&
    !reasons.includes('stroke')
  ) {
    reasons.push('stroke');
  }
  if (reasons.length > 0 || p.type !== 'SOLID' || weight === null) return { kind: 'raster', reasons };
  const dash = Array.isArray(n.dashPattern) ? (n.dashPattern as number[]).filter((v) => typeof v === 'number') : [];
  return {
    kind: 'native',
    stroke: {
      color: solidColor(p),
      weight: clean(weight),
      align: ALIGN[String(n.strokeAlign)] ?? 'center',
      dash: dash.length > 0 && dash.some((v) => v > 0) ? dash.map(clean) : null,
      cap: CAP[String(n.strokeCap)] ?? 'none',
      join: JOIN[String(n.strokeJoin)] ?? 'miter',
      startArrow: 'none',
      endArrow: 'none',
    },
  };
}
