/**
 * Native-vs-raster decisions (pure: node properties in, decision + raster reasons out).
 * The walker (walker.ts) turns decisions into plan items; clipping is decided there.
 *
 * See docs/ARCHITECTURE.md "What becomes what". Summary:
 * - RECTANGLE / frame background: ≤1 visible SOLID or LINEAR fill (or one IMAGE → picture), uniform
 *   radius, ≤1 uniform SOLID stroke, normal blend, no blur, ≤1 shadow with spread 0, no skew.
 * - ELLIPSE: same paint rules, default arc data only.
 * - LINE: one SOLID stroke, same cap at both ends.
 * - TEXT: solid fills only, no stroke / blur / blend, ≤1 shadow, no flip / skew.
 * - Containers rasterize as a whole for masks, blend modes, blur, shadows that need the content's
 *   alpha, group opacity over overlapping painting pieces (at any depth), rotated clips, icon-like
 *   vector groups.
 * - A drop shadow Figma hides behind the node (`showShadowBehindNode` false) on a translucent / missing
 *   fill → `effects` (PowerPoint would show it through the fill).
 */
import { CONFIG } from '../config';
import type { Fill, Matrix, RasterReason, Rect, Shadow, Stroke, TextParagraph, Transform } from '../ir/types';
import type { ExportSettings } from '../shared/settings';
import { analyzeEffects, hasShadowHiddenBehindNode } from './effects';
import {
  applyToPoint,
  clean,
  decompose,
  intersectRects,
  invert,
  isQuarterTurn,
  multiply,
  rectArea,
  transformRectBounds,
  transformedBoxBounds,
} from './geometry';
import {
  absoluteTransformOf,
  blendModeOf,
  childrenOf,
  clipsContentOf,
  effectsOf,
  fillsOf,
  isContainer,
  isFrameLike,
  isMaskNode,
  isRendered,
  opacityOf,
  renderBoundsOf,
  sizeOf,
  strokesOf,
  uniformRadiusOf,
} from './node-props';
import { analyzeFills, analyzeStrokes, isNormalBlend, visiblePaints, type FillAnalysis } from './paints';
import {
  autoResizeOf,
  readSegments,
  segmentFonts,
  segmentsToParagraphs,
  textColor,
  textDefaults,
  textPaintReasons,
  verticalAlignOf,
} from './text';

function pushUnique(list: RasterReason[], ...reasons: RasterReason[]): RasterReason[] {
  for (const r of reasons) if (!list.includes(r)) list.push(r);
  return list;
}

/** Node transform relative to the slide (inverse(frame.absoluteTransform) × node.absoluteTransform). */
export function relativeMatrix(slideInverse: Matrix, node: SceneNode): Matrix {
  return multiply(slideInverse, absoluteTransformOf(node));
}

// ─── Rectangles / ellipses / frame backgrounds ───────────────────────────────

export interface ShapeDecision {
  /** none = paints nothing; image = picture from an IMAGE fill (see images.ts). */
  kind: 'none' | 'native' | 'image' | 'raster';
  reasons: RasterReason[];
  transform: Transform;
  geometry: 'rect' | 'roundRect' | 'ellipse';
  /** px, roundRect only */
  radius: number;
  fill: Fill | null;
  stroke: Stroke | null;
  shadow: Shadow | null;
  imagePaint: ImagePaint | null;
}

export interface ShapeOptions {
  /** Ellipse geometry (ELLIPSE nodes). */
  ellipse?: boolean;
  /** Frame backgrounds: blend / blur / non-shadow effects are decided at container level. */
  frameBackground?: boolean;
  /** Ignore effects entirely (slide root). */
  ignoreEffects?: boolean;
  /** Ignore strokes (frame backgrounds whose stroke is drawn separately). */
  ignoreStrokes?: boolean;
  /** Product of the ancestors' opacity (default 1): part of the fill alpha a native shadow shows through. */
  opacityAbove?: number;
}

/**
 * Alpha of a single native / image fill (gradient: its most transparent stop), 0 without a fill.
 * Raster fills count as opaque (they are rasterized anyway).
 */
function fillAlpha(fills: FillAnalysis): number {
  switch (fills.kind) {
    case 'none':
      return 0;
    case 'native':
      return fills.fill.type === 'solid' ? fills.fill.color.a : Math.min(1, ...fills.fill.stops.map((s) => s.color.a));
    case 'image':
      return fills.paint.opacity ?? 1;
    default:
      return 1;
  }
}

/**
 * A native outer shadow would show through the node: Figma hides the drop shadow behind the node
 * (`showShadowBehindNode` false), PowerPoint draws it behind the whole shape, and the effective fill
 * alpha (fill × layer × ancestors) is below `CONFIG.extract.shadowKnockoutMaxAlpha`.
 */
export function shadowShowsThrough(effects: readonly Effect[], alpha: number): boolean {
  return hasShadowHiddenBehindNode(effects) && alpha < CONFIG.extract.shadowKnockoutMaxAlpha;
}

const DEFAULT_ARC_END = 2 * Math.PI;

/** ELLIPSE without arc data (full circle, no hole). */
export function hasDefaultArc(node: SceneNode): boolean {
  if (node.type !== 'ELLIPSE' || !node.arcData) return true;
  const { startingAngle, endingAngle, innerRadius } = node.arcData;
  const eps = 1e-4;
  const sweep = Math.abs(endingAngle - startingAngle);
  return Math.abs(sweep - DEFAULT_ARC_END) < eps && Math.abs(innerRadius) < eps;
}

/**
 * RECTANGLE / ELLIPSE / frame-background decision. `rel` = slide-relative matrix of the node.
 * Reasons are collected exhaustively (the report lists all of them).
 */
export function classifyShape(
  node: SceneNode,
  mixed: symbol,
  settings: Pick<ExportSettings, 'nativeGradients' | 'imageFills'>,
  rel: Matrix,
  opts: ShapeOptions = {},
): ShapeDecision {
  const { width, height } = sizeOf(node);
  const dec = decompose(rel, width, height);
  const reasons: RasterReason[] = [];
  const fills = analyzeFills(fillsOf(node, mixed), settings);
  const strokes = opts.ignoreStrokes ? ({ kind: 'none' } as const) : analyzeStrokes(node, mixed);
  const effects = opts.ignoreEffects ? null : analyzeEffects(effectsOf(node));

  if (fills.kind === 'raster') pushUnique(reasons, ...fills.reasons);
  if (strokes.kind === 'raster') pushUnique(reasons, ...strokes.reasons);
  if (effects) {
    if (opts.frameBackground) {
      if (effects.reasons.includes('effects') && effects.shadowCount > 0) pushUnique(reasons, 'effects');
    } else pushUnique(reasons, ...effects.reasons);
    if (effects.shadow?.type === 'outer') {
      const alpha = fillAlpha(fills) * opacityOf(node) * (opts.opacityAbove ?? 1);
      if (shadowShowsThrough(effectsOf(node), alpha)) pushUnique(reasons, 'effects');
    }
  }
  if (!opts.frameBackground && !isNormalBlend(blendModeOf(node))) pushUnique(reasons, 'blend-mode');
  if (dec.skewed) pushUnique(reasons, 'transform');

  const radius = opts.ellipse ? 0 : uniformRadiusOf(node, mixed);
  const paintsSomething = fills.kind !== 'none' || strokes.kind !== 'none';
  if (radius === null && paintsSomething) pushUnique(reasons, 'mixed-radii');
  if (opts.ellipse && !hasDefaultArc(node)) pushUnique(reasons, 'vector');
  // The user chose rasterized image fills: the reason is the setting, not the fill.
  if (fills.kind === 'image' && settings.imageFills === 'rasterize') pushUnique(reasons, 'setting');

  const r = radius === null ? 0 : Math.min(radius, Math.min(width, height) / 2);
  const geometry: ShapeDecision['geometry'] = opts.ellipse ? 'ellipse' : r > 0 ? 'roundRect' : 'rect';
  const base = {
    reasons,
    transform: dec.transform,
    geometry,
    radius: geometry === 'roundRect' ? clean(r) : 0,
    fill: fills.kind === 'native' ? fills.fill : null,
    stroke: strokes.kind === 'native' ? strokes.stroke : null,
    shadow: effects?.shadow ?? null,
    imagePaint: fills.kind === 'image' ? fills.paint : null,
  };
  if (!paintsSomething) return { ...base, kind: 'none' };
  if (reasons.length > 0) return { ...base, kind: 'raster' };
  return { ...base, kind: fills.kind === 'image' ? 'image' : 'native' };
}

// ─── Lines ───────────────────────────────────────────────────────────────────

export interface LineDecision {
  kind: 'none' | 'native' | 'raster';
  reasons: RasterReason[];
  transform: Transform;
  stroke: Stroke | null;
  shadow: Shadow | null;
}

const LINE_CAPS: Record<string, { cap: Stroke['cap']; arrow: Stroke['startArrow'] }> = {
  NONE: { cap: 'none', arrow: 'none' },
  ROUND: { cap: 'round', arrow: 'none' },
  SQUARE: { cap: 'square', arrow: 'none' },
  ARROW_LINES: { cap: 'none', arrow: 'arrow' },
  ARROW_EQUILATERAL: { cap: 'none', arrow: 'triangle' },
  TRIANGLE_FILLED: { cap: 'none', arrow: 'triangle' },
  DIAMOND_FILLED: { cap: 'none', arrow: 'diamond' },
  CIRCLE_FILLED: { cap: 'none', arrow: 'oval' },
};

/**
 * LINE: the segment from local (0, 0) to (width, 0). Its slide-space endpoints give an axis-aligned
 * box (w or h may be 0) plus flips that encode the direction (start = top-left corner unless
 * flipped, PowerPoint semantics); rotation is always 0.
 */
export function lineTransform(rel: Matrix, length: number): Transform {
  const p0 = applyToPoint(rel, { x: 0, y: 0 });
  const p1 = applyToPoint(rel, { x: length, y: 0 });
  const eps = 1e-9;
  return {
    x: clean(Math.min(p0.x, p1.x)),
    y: clean(Math.min(p0.y, p1.y)),
    w: clean(Math.abs(p1.x - p0.x)),
    h: clean(Math.abs(p1.y - p0.y)),
    rotation: 0,
    flipH: p0.x > p1.x + eps,
    flipV: p0.y > p1.y + eps,
  };
}

export function classifyLine(node: SceneNode, mixed: symbol, rel: Matrix): LineDecision {
  const transform = lineTransform(rel, sizeOf(node).width);
  const strokes = analyzeStrokes(node, mixed);
  const effects = analyzeEffects(effectsOf(node));
  const reasons: RasterReason[] = [];
  if (strokes.kind === 'none') return { kind: 'none', reasons, transform, stroke: null, shadow: null };
  if (strokes.kind === 'raster') pushUnique(reasons, ...strokes.reasons);
  pushUnique(reasons, ...effects.reasons);
  if (!isNormalBlend(blendModeOf(node))) pushUnique(reasons, 'blend-mode');
  const capValue = (node as unknown as { strokeCap?: unknown }).strokeCap;
  const cap = typeof capValue === 'string' ? LINE_CAPS[capValue] : undefined;
  // figma.mixed = different ends (e.g. an arrow on one end only): not expressible per end here.
  if (!cap) pushUnique(reasons, 'stroke');
  if (reasons.length > 0 || strokes.kind !== 'native' || !cap) {
    return { kind: 'raster', reasons, transform, stroke: null, shadow: null };
  }
  return {
    kind: 'native',
    reasons,
    transform,
    stroke: { ...strokes.stroke, cap: cap.cap, startArrow: cap.arrow, endArrow: cap.arrow },
    shadow: effects.shadow,
  };
}

// ─── Text ────────────────────────────────────────────────────────────────────

export interface TextDecision {
  kind: 'none' | 'native' | 'raster';
  reasons: RasterReason[];
  transform: Transform;
  shadow: Shadow | null;
  paragraphs: TextParagraph[];
  verticalAlign: 'top' | 'middle' | 'bottom';
  autoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  /** Figma fonts used (for the missing-font warning). */
  fonts: FontName[];
  hasMissingFont: boolean;
}

/**
 * TEXT decision without clipping (the walker adds `clip`). `opacityAbove` = product of the ancestors'
 * opacity (a native drop shadow shows through translucent glyphs, see `shadowShowsThrough`).
 */
export function classifyText(node: TextNode, mixed: symbol, rel: Matrix, opacityAbove = 1): TextDecision {
  const dec = decompose(rel, node.width, node.height);
  const defaults = textDefaults(node, mixed);
  const segments = node.characters.length > 0 ? readSegments(node) : [];
  const paragraphs = segmentsToParagraphs(segments, defaults);
  const reasons = textPaintReasons(segments, defaults);
  const hasStroke = visiblePaints(strokesOf(node)).length > 0;
  if (hasStroke) pushUnique(reasons, 'stroke');
  const effects = analyzeEffects(effectsOf(node));
  pushUnique(reasons, ...effects.reasons);
  if (effects.shadow?.type === 'outer') {
    const glyphAlpha = Math.min(1, ...segments.map((seg) => textColor(seg.fills ?? defaults.fills)?.a ?? 1));
    if (shadowShowsThrough(effectsOf(node), glyphAlpha * opacityOf(node) * opacityAbove)) pushUnique(reasons, 'effects');
  }
  if (!isNormalBlend(blendModeOf(node))) pushUnique(reasons, 'blend-mode');
  if (dec.flipped || dec.skewed) pushUnique(reasons, 'transform');
  // Paints anything at all (a gradient-only text has no solid color but is visible).
  const visible = hasStroke || segments.some((seg) => visiblePaints(seg.fills ?? defaults.fills).length > 0);
  return {
    kind: segments.length === 0 || !visible ? 'none' : reasons.length > 0 ? 'raster' : 'native',
    reasons,
    transform: dec.transform,
    shadow: effects.shadow,
    paragraphs,
    verticalAlign: verticalAlignOf(node),
    autoResize: autoResizeOf(node),
    fonts: segmentFonts(segments, defaults),
    hasMissingFont: node.hasMissingFont === true,
  };
}

// ─── Containers ──────────────────────────────────────────────────────────────

/** Visible children (rendered at all). */
export function visibleChildren(node: SceneNode): SceneNode[] {
  return childrenOf(node).filter(isRendered);
}

/** Render bounds in slide px (null when nothing is rendered). */
export function slideRenderBounds(slideInverse: Matrix, node: SceneNode): Rect | null {
  const abs = renderBoundsOf(node);
  return abs && abs.w > 0 && abs.h > 0 ? transformRectBounds(slideInverse, abs) : null;
}

/** Some pair of rectangles overlaps by more than `CONFIG.extract.overlapMinAreaPx2` (sweep over x). */
export function anyOverlap(rects: readonly Rect[]): boolean {
  const minArea = CONFIG.extract.overlapMinAreaPx2;
  const sorted = [...rects].sort((a, b) => a.x - b.x);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].x < a.x + a.w; j++) {
      const inter = intersectRects(a, sorted[j]);
      if (inter && rectArea(inter) > minArea) return true;
    }
  }
  return false;
}

/** Frame-like container paints something itself (fill or stroke). */
export function hasOwnPaint(node: SceneNode, mixed: symbol): boolean {
  if (!isFrameLike(node)) return false;
  const fills = fillsOf(node, mixed);
  return visiblePaints(fills).length > 0 || visiblePaints(strokesOf(node)).length > 0;
}

/**
 * Reasons to rasterize a container as ONE picture (empty = walk its children).
 * `isRoot`: the slide root never rasterizes as a whole (masks there become range composites, its
 * effects go with the slide background or are reported — walker `rootEffects`).
 */
export function containerRasterReasons(node: SceneNode, mixed: symbol, slideInverse: Matrix, isRoot = false): RasterReason[] {
  const reasons: RasterReason[] = [];
  if (isRoot) return reasons;
  const kids = visibleChildren(node);
  if (kids.some(isMaskNode)) pushUnique(reasons, 'mask');
  if (!isNormalBlend(blendModeOf(node))) pushUnique(reasons, 'blend-mode');
  const effects = analyzeEffects(effectsOf(node));
  if (effects.hasBlur) pushUnique(reasons, 'blur');
  // Noise / texture / glass / shader effects apply to the whole content.
  const otherEffects = effectsOf(node).some(
    (e) => (e as { visible?: boolean }).visible !== false && !['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'].includes(e.type),
  );
  if (otherEffects) pushUnique(reasons, 'effects');
  if (effects.shadowCount > 0) {
    // A group (or a frame without a fill) casts its shadow from the children's pixels.
    const hasFill = isFrameLike(node) && visiblePaints(fillsOf(node, mixed)).length > 0;
    if (!hasFill) pushUnique(reasons, 'effects');
  }
  if (opacityOf(node) < 1 && kids.length > 0) {
    // The opacity is multiplied into every painting piece (PowerPoint groups have no opacity); Figma
    // composites the container first. Different as soon as two pieces overlap — at ANY depth.
    const rects = paintingPieces(node, mixed, slideInverse);
    if (hasOwnPaint(node, mixed)) rects.push(ownBox(node, slideInverse));
    if (rects.length >= 2 && anyOverlap(rects)) pushUnique(reasons, 'group-opacity');
  }
  if (clipsContentOf(node) && kids.length > 0 && !isAxisAlignedClip(node, slideInverse) && childrenOverflow(node, kids)) {
    pushUnique(reasons, 'clip');
  }
  return reasons;
}

/** Box of a node in slide px (axis-aligned bounds of its transformed box). */
function ownBox(node: SceneNode, slideInverse: Matrix): Rect {
  const { width, height } = sizeOf(node);
  return transformedBoxBounds(multiply(slideInverse, absoluteTransformOf(node)), width, height);
}

/**
 * Slide-px boxes of the pieces the walk turns the descendants of `node` into, each of which gets the
 * container's opacity separately: leaves (render bounds), containers that become ONE picture (render
 * bounds: rasterized as a whole or icon-like) and, for containers that are walked, their own paint
 * (fill / stroke box) plus their descendants' pieces.
 */
function paintingPieces(node: SceneNode, mixed: symbol, slideInverse: Matrix): Rect[] {
  const out: Rect[] = [];
  const visit = (parent: SceneNode) => {
    for (const kid of visibleChildren(parent)) {
      const walked = isContainer(kid) && !isIconLike(kid, mixed) && containerRasterReasons(kid, mixed, slideInverse).length === 0;
      if (!walked) {
        const r = slideRenderBounds(slideInverse, kid);
        if (r) out.push(r);
        continue;
      }
      if (hasOwnPaint(kid, mixed)) out.push(ownBox(kid, slideInverse));
      visit(kid);
    }
  };
  visit(node);
  return out;
}

/** The frame's box is axis-aligned in slide space (rotation a multiple of 90°, no skew). */
export function isAxisAlignedClip(node: SceneNode, slideInverse: Matrix): boolean {
  const { width, height } = sizeOf(node);
  const dec = decompose(multiply(slideInverse, absoluteTransformOf(node)), width, height);
  return !dec.skewed && isQuarterTurn(dec.transform.rotation);
}

/** Some child box leaves the frame box (frame-local coordinates). */
function childrenOverflow(frame: SceneNode, kids: readonly SceneNode[]): boolean {
  let inverse: Matrix;
  try {
    inverse = invert(absoluteTransformOf(frame));
  } catch {
    return true;
  }
  const { width, height } = sizeOf(frame);
  const eps = CONFIG.extract.geometryEpsilonPx;
  return kids.some((k) => {
    const { width: w, height: h } = sizeOf(k);
    const b = transformedBoxBounds(multiply(inverse, absoluteTransformOf(k)), w, h);
    return b.x < -eps || b.y < -eps || b.x + b.w > width + eps || b.y + b.h > height + eps;
  });
}

const VECTOR_LEAVES = new Set(['VECTOR', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION']);
const SIMPLE_SHAPES = new Set(['LINE', 'ELLIPSE', 'RECTANGLE']);
const ICON_CONTAINERS = new Set(['GROUP', 'FRAME', 'COMPONENT', 'INSTANCE']);

function hasImagePaint(node: SceneNode, mixed: symbol): boolean {
  const fills = fillsOf(node, mixed);
  const paints = [...visiblePaints(fills), ...visiblePaints(strokesOf(node))];
  return paints.some((p) => p.type === 'IMAGE' || p.type === 'VIDEO');
}

/**
 * Icon-like container: only vector-like descendants (vectors, stars, polygons, boolean operations,
 * lines, ellipses, rectangles, nested groups / frames — none with image fills), no text, at least
 * `CONFIG.raster.iconMinLeaves` vector leaves, longest side ≤ `CONFIG.raster.iconMaxSize` px.
 * Exported once (SVG + PNG) instead of one picture per tiny vector.
 */
export function isIconLike(node: SceneNode, mixed: symbol): boolean {
  if (!isContainer(node) || !ICON_CONTAINERS.has(node.type)) return false;
  const { width, height } = sizeOf(node);
  if (Math.max(width, height) > CONFIG.raster.iconMaxSize) return false;
  if (hasImagePaint(node, mixed)) return false;
  let leaves = 0;
  const visit = (n: SceneNode): boolean => {
    for (const child of childrenOf(n)) {
      if (!isRendered(child)) continue;
      if (VECTOR_LEAVES.has(child.type)) {
        if (hasImagePaint(child, mixed)) return false;
        leaves++;
      } else if (SIMPLE_SHAPES.has(child.type)) {
        if (hasImagePaint(child, mixed)) return false;
      } else if (ICON_CONTAINERS.has(child.type)) {
        if (hasImagePaint(child, mixed) || !visit(child)) return false;
      } else return false;
    }
    return true;
  };
  return visit(node) && leaves >= CONFIG.raster.iconMinLeaves;
}
