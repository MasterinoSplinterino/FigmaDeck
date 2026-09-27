/**
 * Tree walk of one slide ("editable" mode): Figma nodes → plan (native elements + export jobs).
 *
 * Walk state: effective opacity of the ancestors (PowerPoint groups have no opacity, so it is baked
 * into the leaves; a raster's own opacity is baked into its bitmap, so a picture gets the ANCESTORS'
 * product only) and the clip state (clip.ts).
 *
 * Clipping (verified: `absoluteRenderBounds` and default exports are already clipped by every
 * ancestor with `clipsContent`; a visible node clipped away entirely has render bounds `null`):
 * - render bounds `null` (or fully outside the clip) → skipped, one 'outside-clip' report entry for
 *   the top-most skipped node;
 * - rasters exported in place are placed at their (clipped) render bounds and never cropped again;
 * - cut by a RECTANGULAR clipping frame, NATIVE elements are clipped by hand: plain image fills cropped
 *   (`srcRect`), plain rectangles intersected, everything else — including pictures with an ellipse /
 *   rounded geometry or a shadow, which a crop would redraw on the cut box — rasterized ('clip') in place;
 * - cut only by the slide edge: plain pictures cropped, plain rectangles intersected, the rest (shaped
 *   or shadowed pictures included) kept native and whole (PowerPoint itself clips at the slide edge);
 * - reaching into a ROUNDED corner of a clipping frame: temporary composite with that frame (cropped
 *   to the clips above the frame, which the clone at the page root escapes).
 */
import { CONFIG } from '../config';
import type {
  Element,
  ImageElement,
  Matrix,
  RasterReason,
  Rect,
  Shadow,
  ShapeElement,
  SolidFill,
  TextElement,
  TextParagraph,
  Transform,
} from '../ir/types';
import type { ExportSettings } from '../shared/settings';
import { imageKey, type AssetStore } from './assets';
import {
  classifyLine,
  classifyShape,
  classifyText,
  containerRasterReasons,
  isAxisAlignedClip,
  isIconLike,
  relativeMatrix,
  type ShapeDecision,
} from './classify';
import {
  initialClip,
  makeRoundedClip,
  pushClip,
  reachesRoundedCorner,
  testClip,
  type ClipState,
  type ClipTest,
  type RoundedClip,
} from './clip';
import { analyzeEffects } from './effects';
import type { FigmaEnv } from './figma-env';
import {
  IDENTITY,
  clean,
  containsRect,
  decompose,
  intersectRects,
  invert,
  multiply,
  placeAbsoluteRect,
  rectsEqual,
  transformRectBounds,
  transformedBoxBounds,
  unionRects,
} from './geometry';
import { computeImageCrop, cropPictureToRect, imagePaintReasons, subRectTransform } from './images';
import {
  absoluteTransformOf,
  blendModeOf,
  boundingBoxOf,
  childrenOf,
  clipsContentOf,
  cornerRadiiOf,
  effectsOf,
  fillsOf,
  isContainer,
  isMaskNode,
  isRendered,
  opacityOf,
  pathFrom,
  renderBoundsOf,
  sizeOf,
  strokesOf,
  uniformRadiusOf,
} from './node-props';
import { resolveAutoLineHeights, type MeasureLineHeight } from './line-height';
import { analyzeStrokes, isNormalBlend, visiblePaints } from './paints';
import { planElement, planJob, type Plan } from './plan';
import { isCancelledError, throwIfCancelled, type CancelCheck } from './pool';
import {
  exportComposite,
  exportPicture,
  wantsSvg,
  type CompositeSpec,
  type ExportedPicture,
  type RasterContext,
  type TempNodes,
} from './raster';
import { nodeRef, type ReportSlot, type SlideReport } from './report';
import { readPngInfo, sniffImageMime } from './png';

/** Everything the walk of one slide needs. */
export interface SlideContext {
  env: FigmaEnv;
  settings: ExportSettings;
  /** The slide root frame. */
  frame: SceneNode;
  /** inverse(frame.absoluteTransform) */
  slideInverse: Matrix;
  /** { 0, 0, frame.width, frame.height } */
  slideRect: Rect;
  /** The root frame clips its content: Figma's render bounds / exports are cut at the slide edge too. */
  rootClips: boolean;
  assets: AssetStore;
  temp: TempNodes;
  report: SlideReport;
  /** Image bytes per Figma image hash, shared across slides. */
  images: ImageCache;
  isCancelled?: CancelCheck;
  /** Called after every visited node (count so far). */
  onVisit?: (visited: number) => void;
  visited: number;
  /** Measures `lineHeight: AUTO` (line-height.ts); absent = AUTO stays in the IR. */
  measureLineHeight?: MeasureLineHeight;
}

export interface ImageInfo {
  /** Asset id, or null when the format cannot be embedded (→ rasterize). */
  assetId: string | null;
  width: number;
  height: number;
}

export type ImageCache = Map<string, Promise<ImageInfo | null>>;

interface WalkState {
  /** Product of the ancestors' opacity (NOT including the current node). */
  opacity: number;
  clip: ClipState;
}

type Meta = { id: string; name: string; node: SceneNode };

/** Slide-root effects drawn with the slide background (see `SlideWalker.rootEffects`). */
interface RootEffects {
  /** A native inner shadow for the background shape. */
  shadow: Shadow | null;
  /** Reasons for a background composite WITH the effects (empty = none needed). */
  composite: RasterReason[];
}

const NO_ROOT_EFFECTS: RootEffects = { shadow: null, composite: [] };

const pushUnique = (list: RasterReason[], ...reasons: RasterReason[]) => {
  for (const r of reasons) if (!list.includes(r)) list.push(r);
  return list;
};

function rasterContext(ctx: SlideContext): RasterContext {
  return { env: ctx.env, settings: ctx.settings, assets: ctx.assets, temp: ctx.temp };
}

async function tick(ctx: SlideContext): Promise<void> {
  ctx.visited++;
  if (ctx.onVisit) ctx.onVisit(ctx.visited);
  if (ctx.visited % Math.max(1, CONFIG.export.yieldEveryNodes) === 0) {
    await ctx.env.yieldToEventLoop();
    throwIfCancelled(ctx.isCancelled);
  }
}

// ─── Pictures ────────────────────────────────────────────────────────────────

/**
 * Picture element for an exported bitmap, placed at `picture.region` (origin of the render bounds,
 * size = bitmap px / scale). `clip` (slide px) is a clip Figma did NOT apply to this bitmap — the
 * clips above a composite's clone, the slide edge of a non-clipping root — and crops the picture
 * only where it reaches past it by more than one bitmap pixel (the last pixel column / row may
 * overhang the render bounds by up to 1/scale px; that is not a cut). `null` when fully clipped.
 */
export function pictureElement(
  ctx: Pick<SlideContext, 'slideInverse'>,
  meta: { id: string; name: string },
  picture: Pick<ExportedPicture, 'assetId' | 'svgAssetId' | 'region' | 'scale'>,
  opacity: number,
  reasons: RasterReason[] | null,
  clip: Rect | null,
): ImageElement | null {
  let transform = placeAbsoluteRect(ctx.slideInverse, picture.region);
  let crop: ImageElement['crop'] = null;
  const pixel = picture.scale > 0 ? 1 / picture.scale : 1;
  if (clip && transform.rotation === 0 && !containsRect(clip, transform, Math.max(1e-6, pixel))) {
    const cropped = cropPictureToRect(transform, null, clip);
    if (!cropped) return null;
    transform = cropped.transform;
    crop = cropped.crop;
  }
  const el: ImageElement = {
    type: 'image',
    id: meta.id,
    name: meta.name,
    transform,
    opacity: clean(opacity),
    shadow: null,
    assetId: picture.assetId,
    svgAssetId: picture.svgAssetId,
    crop,
    geometry: 'rect',
    cornerRadius: 0,
  };
  if (reasons) el.rasterized = { reasons: [...reasons] };
  return el;
}

/** Extent of a node for clip tests, or why there is none (see `SlideWalker.clipExtent`). */
type ClipExtent = { kind: 'ok'; visual: Rect; abs: Rect } | { kind: 'empty' } | { kind: 'clipped' };

/**
 * The node paints nothing by itself (no visible fill / stroke / effect, no painting child, empty
 * text): a `null` render bounds then means "empty", not "clipped away".
 */
export function paintsNothing(node: SceneNode, mixed: symbol): boolean {
  if (node.type === 'TEXT' && node.characters.length === 0) return true;
  const fills = fillsOf(node, mixed);
  if (fills === 'mixed' || visiblePaints(fills).length > 0 || visiblePaints(strokesOf(node)).length > 0) return false;
  if (effectsOf(node).some((e) => (e as { visible?: boolean }).visible !== false)) return false;
  if (isContainer(node)) return childrenOf(node).every((c) => !isRendered(c) || paintsNothing(c, mixed));
  // Leaves without paint properties (stickies, embeds, widgets…) are assumed to paint.
  return 'fills' in node;
}

/**
 * A closed shape that paints past ALL of its box edges (outer shadow, layer blur, stroke not inside):
 * when its box edge lies exactly on a clip edge, the render bounds stopping there mean that overhang
 * was cut. Not for text (a glyph box on the frame edge is usually a coincidence, and rasterizing text
 * by mistake costs more than a sub-pixel overhang), lines (no overhang along a NONE-capped line, e.g.
 * a full-width divider) or containers (their children are tested on their own).
 */
export function paintsOutsideBox(node: SceneNode): boolean {
  if (node.type === 'TEXT' || node.type === 'LINE') return false;
  if (isContainer(node)) return false;
  const effects = effectsOf(node).some((e) => {
    if ((e as { visible?: boolean }).visible === false) return false;
    if (e.type === 'DROP_SHADOW') return e.color.a > 0;
    return e.type === 'LAYER_BLUR' && e.radius > 0;
  });
  if (effects) return true;
  if (visiblePaints(strokesOf(node)).length === 0) return false;
  const n = node as unknown as { strokeWeight?: unknown; strokeAlign?: unknown };
  if (typeof n.strokeWeight === 'number' && n.strokeWeight <= 0) return false;
  return n.strokeAlign !== 'INSIDE';
}

/**
 * Extend `v` (slide px) past the edges of `cut` where Figma cut the node. Per side where the render
 * bounds `r` stop on the cut edge (within `CONFIG.extract.clipEdgeTolerancePx`) and nothing of `v`
 * lies beyond it yet:
 * - the bounding box `b` reaches beyond the edge (text: layout box) → extend to it;
 * - `b` stays clearly inside → the render bounds overhang the box on that side and were cut there →
 *   1 px past the edge;
 * - `b` ends on the edge too → cut only if the node paints past its own edges (`overhangsOwnBox`).
 */
export function extendAtCutEdges(v: Rect, r: Rect, b: Rect | null, cut: Rect, overhangsOwnBox: boolean): Rect {
  const tol = CONFIG.extract.clipEdgeTolerancePx;
  const lo = [v.x, v.y];
  const hi = [v.x + v.w, v.y + v.h];
  const rLo = [r.x, r.y];
  const rHi = [r.x + r.w, r.y + r.h];
  const bLo = b ? [b.x, b.y] : null;
  const bHi = b ? [b.x + b.w, b.y + b.h] : null;
  const cLo = [cut.x, cut.y];
  const cHi = [cut.x + cut.w, cut.y + cut.h];
  for (let axis = 0; axis < 2; axis++) {
    if (Math.abs(rLo[axis] - cLo[axis]) <= tol && lo[axis] > cLo[axis] - tol) {
      if (bLo && bLo[axis] < cLo[axis] - tol) lo[axis] = bLo[axis];
      else if ((bLo && bLo[axis] > cLo[axis] + tol) || overhangsOwnBox) lo[axis] = cLo[axis] - 1;
    }
    if (Math.abs(rHi[axis] - cHi[axis]) <= tol && hi[axis] < cHi[axis] + tol) {
      if (bHi && bHi[axis] > cHi[axis] + tol) hi[axis] = bHi[axis];
      else if ((bHi && bHi[axis] < cHi[axis] - tol) || overhangsOwnBox) hi[axis] = cHi[axis] + 1;
    }
  }
  return { x: lo[0], y: lo[1], w: hi[0] - lo[0], h: hi[1] - lo[1] };
}

/**
 * Masked ranges among siblings, as [mask index, end) pairs: a (visible) mask clips every sibling
 * above it, up to the next mask.
 */
export function maskRanges(kids: readonly SceneNode[]): Array<[number, number]> {
  const isMask = (n: SceneNode) => isRendered(n) && isMaskNode(n);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < kids.length; i++) {
    if (!isMask(kids[i])) continue;
    let end = i + 1;
    while (end < kids.length && !isMask(kids[end])) end++;
    ranges.push([i, end]);
    i = end - 1;
  }
  return ranges;
}

/** Opacity to give an exported picture of `node`, given the opacity above it. */
function exportedOpacity(opacityAbove: number, node: SceneNode): number {
  return CONFIG.extract.exportIncludesOwnOpacity ? opacityAbove : opacityAbove * opacityOf(node);
}

// ─── Walker ──────────────────────────────────────────────────────────────────

export class SlideWalker {
  constructor(private readonly ctx: SlideContext) {}

  get mixed(): symbol {
    return this.ctx.env.mixed;
  }

  /** Plan for the whole slide root (editable mode). */
  async planRoot(): Promise<{ plans: Plan[]; background: SolidFill | null }> {
    const { ctx } = this;
    const root = ctx.frame;
    const state0: WalkState = { opacity: 1, clip: initialClip(ctx.slideRect) };
    const background = slideBackground(root, this.mixed);
    const own = this.planOwnPaint(root, state0, true, background !== null, this.rootEffects(root));
    const clip = clipsContentOf(root) ? pushClip(state0.clip, ctx.slideRect, this.roundedClipOf(root, 1, ctx.slideRect), true) : state0.clip;
    const childState: WalkState = { opacity: opacityOf(root), clip };
    const children = await this.planRootChildren(root, childState);
    return { plans: [...own.below, ...children, ...own.above], background };
  }

  /**
   * Effects of the slide root, which never rasterizes as a whole (its content stays editable):
   * - DROP_SHADOW lies outside the slide, BACKGROUND_BLUR blurs what is behind the frame (not part of
   *   the slide): ignored, one info entry each;
   * - INNER_SHADOW, LAYER_BLUR, noise / texture / … paint over the root's fill: drawn with the slide
   *   background — a native inner shadow on the background shape when that is possible, otherwise a
   *   background composite with the effects (the first element). LAYER_BLUR also blurs the layers on
   *   the slide in Figma, which stay sharp here (warning). Without a fill there is no background to
   *   carry them (the effect then works on the layers' pixels): dropped, with a warning.
   */
  private rootEffects(root: SceneNode): RootEffects {
    const { report } = this.ctx;
    const fx: RootEffects = { shadow: null, composite: [] };
    const visible = effectsOf(root).filter((e) => {
      if ((e as { visible?: boolean }).visible === false) return false;
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') return e.color.a > 0;
      if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') return e.radius > 0;
      return true;
    });
    if (visible.length === 0) return fx;
    const ref = nodeRef(root);
    const types = new Set(visible.map((e) => e.type));
    if (types.has('DROP_SHADOW')) {
      report.info('root-effect-ignored', `The drop shadow of the slide frame "${root.name}" lies outside the slide and was ignored.`, ref);
    }
    if (types.has('BACKGROUND_BLUR')) {
      report.info('root-effect-ignored', `The background blur of the slide frame "${root.name}" only blurs what lies behind the slide and was ignored.`, ref);
    }
    const kept = visible.filter((e) => e.type !== 'DROP_SHADOW' && e.type !== 'BACKGROUND_BLUR');
    if (kept.length === 0) return fx;
    const names = [...new Set(kept.map((e) => e.type.toLowerCase().replace(/_/g, ' ')))].join(', ');
    if (visiblePaints(fillsOf(root, this.mixed)).length === 0) {
      report.warning('root-effect-dropped', `The slide frame "${root.name}" has no fill to carry its effects (${names}); they were dropped.`, ref);
      return fx;
    }
    if (types.has('LAYER_BLUR')) {
      report.warning(
        'root-effect-dropped',
        `The layer blur of the slide frame "${root.name}" is applied to the slide background only; the layers on the slide stay sharp.`,
        ref,
      );
    }
    const analysis = analyzeEffects(kept);
    if (analysis.reasons.length === 0 && analysis.shadow) fx.shadow = analysis.shadow;
    else fx.composite = analysis.reasons.length > 0 ? analysis.reasons : ['effects'];
    return fx;
  }

  /** Root children; masks become composites of the masked range (root keeps its editable content). */
  private async planRootChildren(root: SceneNode, state: WalkState): Promise<Plan[]> {
    const { ctx } = this;
    const kids = childrenOf(root);
    const ranges = maskRanges(kids);
    const plans: Plan[] = [];
    let i = 0;
    while (i < kids.length) {
      const range = ranges.find(([start]) => start === i);
      if (!range) {
        plans.push(...(await this.planNode(kids[i], state)));
        i++;
        continue;
      }
      const [start, end] = range;
      const mask = kids[start];
      const keep: number[][] = [];
      for (let k = start; k < end; k++) if (isRendered(kids[k])) keep.push([k]);
      await tick(this.ctx);
      if (keep.length > 1) {
        plans.push(
          this.compositePlan(
            { ancestor: root, keep, stripAncestor: true },
            { id: `~mask:${mask.id}`, name: mask.name, node: mask },
            ['mask'],
            exportedOpacity(1, root),
            ctx.slideRect,
          ),
        );
      }
      i = end;
    }
    return plans;
  }

  // ── "Exact look" mode ──

  /**
   * Native text layers for "Exact look": every TEXT that would be native in editable mode, outside
   * rasterized containers (mask / blend / blur / group opacity…) and not cut where the clip rules
   * rasterize text. Returns the elements with their child-index paths from the root (to hide them in
   * the background composite). Texts that stay in the background are reported with their reasons.
   */
  async collectExactTexts(): Promise<Array<{ element: TextElement; path: number[] }>> {
    const { ctx } = this;
    const root = ctx.frame;
    const out: Array<{ element: TextElement; path: number[] }> = [];
    const state0: WalkState = { opacity: 1, clip: initialClip(ctx.slideRect) };
    const clip = clipsContentOf(root) ? pushClip(state0.clip, ctx.slideRect, this.roundedClipOf(root, 1, ctx.slideRect), true) : state0.clip;
    const kids = childrenOf(root);
    // Children in a mask range stay in the background.
    const masked = new Set<number>();
    for (const [start, end] of maskRanges(kids)) for (let j = start; j < end; j++) masked.add(j);
    for (let i = 0; i < kids.length; i++) {
      if (masked.has(i)) {
        await this.reportBackgroundTexts(kids[i], ['mask']);
        continue;
      }
      await this.exactTexts(kids[i], [i], { opacity: opacityOf(root), clip }, out);
    }
    return out;
  }

  private async exactTexts(node: SceneNode, path: number[], state: WalkState, out: Array<{ element: TextElement; path: number[] }>): Promise<void> {
    const { ctx } = this;
    await tick(ctx);
    if (!isRendered(node)) return;
    const ext = this.clipExtent(node, state);
    if (ext.kind !== 'ok') return; // stays out of the background too (clipped away / empty)
    const ct = testClip(state.clip, ext.visual, ext.abs);
    if (ct.outside) return;
    if (isContainer(node)) {
      const reasons = containerRasterReasons(node, this.mixed, ctx.slideInverse);
      if (reasons.length > 0) {
        await this.reportBackgroundTexts(node, reasons);
        return;
      }
      let clip = state.clip;
      if (clipsContentOf(node)) {
        const { width, height } = sizeOf(node);
        const frameRect = isAxisAlignedClip(node, ctx.slideInverse)
          ? transformedBoxBounds(relativeMatrix(ctx.slideInverse, node), width, height)
          : null;
        clip = pushClip(state.clip, frameRect, this.roundedClipOf(node, state.opacity, state.clip.rect));
      }
      const kids = childrenOf(node);
      for (let i = 0; i < kids.length; i++) {
        await this.exactTexts(kids[i], [...path, i], { opacity: state.opacity * opacityOf(node), clip }, out);
      }
      return;
    }
    if (node.type !== 'TEXT') return;
    const d = classifyText(node, this.mixed, relativeMatrix(ctx.slideInverse, node), state.opacity);
    if (d.kind === 'none') return;
    const reasons = [...d.reasons];
    if ((ct.innerPartial || ct.rounded) && ctx.settings.clippedText === 'rasterize') pushUnique(reasons, 'clip');
    if (reasons.length > 0) {
      ctx.report.rasterized(nodeRef(node), reasons);
      return;
    }
    this.reportTextWarnings(node, d);
    await this.resolveLineHeights(d.paragraphs);
    out.push({ element: textElement(node, d, state.opacity * opacityOf(node)), path });
  }

  /** Report the visible texts inside a subtree that stays in the "Exact look" background. */
  private async reportBackgroundTexts(node: SceneNode, reasons: RasterReason[]): Promise<void> {
    const stack: SceneNode[] = [node];
    while (stack.length > 0) {
      const n = stack.pop()!;
      await tick(this.ctx);
      if (!isRendered(n)) continue;
      if (n.type === 'TEXT') this.ctx.report.rasterized(nodeRef(n), reasons);
      else stack.push(...childrenOf(n));
    }
  }

  /**
   * Extent of `node` for clip tests. Figma's render bounds are already cut by clipping ancestors, so
   * alone they cannot tell whether a node is clipped: shapes use render bounds ∪ bounding box (the
   * box is never clipped); text uses its glyph box (an oversized layout box alone is no cut),
   * extended to the layout box where the glyphs stop at a clip edge; a render edge on a clip edge of a
   * node that paints outside its box (shadow, outer stroke) is pushed past that edge.
   * `clipped` = render bounds `null` although the node paints: clipped away entirely.
   */
  private clipExtent(node: SceneNode, state: WalkState): ClipExtent {
    const { ctx } = this;
    const render = renderBoundsOf(node);
    if (!render) return paintsNothing(node, this.mixed) ? { kind: 'empty' } : { kind: 'clipped' };
    const min = CONFIG.raster.minVisibleSizePx;
    if (render.w < 0 || render.h < 0 || (render.w < min && render.h < min)) return { kind: 'empty' };
    const box = boundingBoxOf(node);
    const r = transformRectBounds(ctx.slideInverse, render);
    const b = box ? transformRectBounds(ctx.slideInverse, box) : null;
    let v = node.type === 'TEXT' || !b ? r : (unionRects([r, b]) ?? r);
    // Clips Figma applied to the render bounds: axis-aligned clipping ancestors, the slide if the root clips.
    const cut = ctx.rootClips ? state.clip.rect : state.clip.inner;
    if (cut) v = extendAtCutEdges(v, r, b, cut, paintsOutsideBox(node));
    // A zero-thickness side (hairlines) is widened to the minimum visible size.
    const w = Math.max(v.w, min);
    const h = Math.max(v.h, min);
    const visual = { x: v.x - (w - v.w) / 2, y: v.y - (h - v.h) / 2, w, h };
    return { kind: 'ok', visual, abs: transformRectBounds(absoluteTransformOf(ctx.frame), visual) };
  }

  async planChildren(parent: SceneNode, state: WalkState): Promise<Plan[]> {
    const plans: Plan[] = [];
    for (const child of childrenOf(parent)) plans.push(...(await this.planNode(child, state)));
    return plans;
  }

  async planNode(node: SceneNode, state: WalkState): Promise<Plan[]> {
    const { ctx } = this;
    await tick(ctx);
    if (!isRendered(node) || node.type === 'SLICE') return [];
    const ext = this.clipExtent(node, state);
    if (ext.kind === 'empty') return [];
    const ct = ext.kind === 'ok' ? testClip(state.clip, ext.visual, ext.abs) : null;
    if (!ct || ct.outside) {
      // Children are not visited: one entry for the top-most skipped node.
      ctx.report.skipped(nodeRef(node), 'outside-clip', `"${node.name}" is outside the slide or its clipping frame and was skipped.`);
      return [];
    }
    if (isContainer(node)) return this.planContainer(node, state, ct);
    switch (node.type) {
      case 'TEXT':
        return await this.planText(node, state, ct);
      case 'RECTANGLE':
        return this.planShape(node, state, ct, false);
      case 'ELLIPSE':
        return this.planShape(node, state, ct, true);
      case 'LINE':
        return this.planLine(node, state, ct);
      case 'VECTOR':
      case 'STAR':
      case 'POLYGON':
        return [this.rasterPlan(node, ['vector'], state, ct)];
      case 'BOOLEAN_OPERATION':
        return [this.rasterPlan(node, ['boolean-operation'], state, ct)];
      case 'TEXT_PATH':
        return [this.rasterPlan(node, ['text-feature'], state, ct)];
      default:
        return [this.rasterPlan(node, ['unsupported-node'], state, ct)];
    }
  }

  // ── Containers ──

  private async planContainer(node: SceneNode, state: WalkState, ct: ClipTest): Promise<Plan[]> {
    const { ctx } = this;
    const reasons = containerRasterReasons(node, this.mixed, ctx.slideInverse);
    if (reasons.length > 0) return [this.rasterPlan(node, reasons, state, ct)];
    if (isIconLike(node, this.mixed)) return [this.rasterPlan(node, ['vector'], state, ct)];

    const own = this.planOwnPaint(node, state, false, false);
    const opacity = state.opacity * opacityOf(node);
    let clip = state.clip;
    if (clipsContentOf(node)) {
      // Rotated clipping frames with overflowing children were rasterized above; their rounded
      // corners still apply (tested in the frame's local space).
      const { width, height } = sizeOf(node);
      const frameRect = isAxisAlignedClip(node, ctx.slideInverse)
        ? transformedBoxBounds(relativeMatrix(ctx.slideInverse, node), width, height)
        : null;
      clip = pushClip(state.clip, frameRect, this.roundedClipOf(node, state.opacity, state.clip.rect));
    }
    const children = await this.planChildren(node, { opacity, clip });
    const items = [...own.below, ...children, ...own.above];
    if (!ctx.settings.preserveGroups) return items;
    return [{ kind: 'group', id: node.id, name: node.name, children: items }];
  }

  private roundedClipOf(node: SceneNode, opacityAbove: number, clipAbove: Rect): RoundedClip | null {
    const radii = cornerRadiiOf(node, this.mixed);
    if (!radii) return null;
    let inverse: Matrix;
    try {
      inverse = invert(absoluteTransformOf(node));
    } catch {
      return null;
    }
    const { width, height } = sizeOf(node);
    const rc = makeRoundedClip(node, inverse, width, height, radii);
    return rc ? { ...rc, opacityAbove, clipAbove } : null;
  }

  /**
   * Frame own paint: background (fills + shadow) and stroke. Figma draws a frame's stroke ABOVE its
   * children only when the frame clips its content (with "Clip content" off the children cover the
   * stroke), so the stroke goes to `above` for clipping frames and right after the fill otherwise.
   */
  private planOwnPaint(
    node: SceneNode,
    state: WalkState,
    isRoot: boolean,
    fillIsSlideBackground: boolean,
    rootFx: RootEffects = NO_ROOT_EFFECTS,
  ): { below: Plan[]; above: Plan[] } {
    const { ctx } = this;
    const below: Plan[] = [];
    const above: Plan[] = [];
    if (node.type === 'GROUP') return { below, above };
    const rel = relativeMatrix(ctx.slideInverse, node);
    const opacity = state.opacity * opacityOf(node);
    const { width, height } = sizeOf(node);
    // Own-paint clip test uses the frame box, not the render bounds (those include the children).
    const box = boundingBoxOf(node);
    const ct: ClipTest = box
      ? testClip(state.clip, transformRectBounds(ctx.slideInverse, box), box)
      : { outside: false, innerPartial: false, slidePartial: false, rounded: null };
    if (ct.outside) return { below, above };

    // Root effects drawn with the background (rootEffects) need a background element even when the
    // fill itself is the slide background.
    const fxInBg = rootFx.shadow !== null || rootFx.composite.length > 0;
    const bg =
      fillIsSlideBackground && !fxInBg
        ? null
        : classifyShape(node, this.mixed, ctx.settings, rel, {
            frameBackground: true,
            ignoreStrokes: true,
            ignoreEffects: isRoot,
            opacityAbove: state.opacity,
          });
    // A composite of the background keeps the node's effects — for the root only those it draws there.
    const bgEffects = !isRoot || fxInBg;
    const strokes = analyzeStrokes(node, this.mixed);
    const radius = uniformRadiusOf(node, this.mixed);
    const skewed = decompose(rel, width, height).skewed;
    const strokeReasons: RasterReason[] = strokes.kind === 'raster' ? [...strokes.reasons] : [];
    if (strokes.kind !== 'none' && radius === null) pushUnique(strokeReasons, 'mixed-radii');
    if (strokes.kind !== 'none' && skewed) pushUnique(strokeReasons, 'transform');
    const strokeAbove = clipsContentOf(node);

    const ownPaintComposite = (keep: { fills: boolean; strokes: boolean; effects: boolean }, reasons: RasterReason[], suffix: string): Plan =>
      this.ownPaintComposite(node, state, ct, keep, reasons, suffix);

    // Background (fills + shadow).
    let bgShape: ShapeElement | null = null;
    if (bg && bg.kind === 'native' && rootFx.composite.length === 0) {
      bgShape = this.shapeElement(`~bg:${node.id}`, node.name, bg, opacity, bg.fill, null);
      if (rootFx.shadow) bgShape.shadow = rootFx.shadow; // the root's inner shadow, native
    } else if (bg && bg.kind === 'image' && !fxInBg) {
      below.push(
        ...this.planImageLayer(
          node,
          bg,
          state,
          ct,
          (reasons) => ownPaintComposite({ fills: true, strokes: false, effects: bgEffects }, reasons, 'bg'),
          `~bg:${node.id}`,
          false,
        ),
      );
    } else if (bg && bg.kind !== 'none') {
      // Raster fill, or root effects that cannot go on a native background.
      const reasons = bg.kind === 'raster' ? [...bg.reasons] : [];
      pushUnique(reasons, ...(rootFx.composite.length > 0 ? rootFx.composite : fxInBg ? ['effects' as const] : []));
      below.push(ownPaintComposite({ fills: true, strokes: false, effects: bgEffects }, reasons, 'bg'));
    }

    // Stroke.
    let strokePlan: Plan | null = null;
    if (strokes.kind === 'native' && strokeReasons.length === 0) {
      const decision: ShapeDecision = {
        kind: 'native',
        reasons: [],
        transform: decompose(rel, width, height).transform,
        geometry: radius && radius > 0 ? 'roundRect' : 'rect',
        radius: radius && radius > 0 ? clean(Math.min(radius, Math.min(width, height) / 2)) : 0,
        fill: null,
        stroke: strokes.stroke,
        shadow: null,
        imagePaint: null,
      };
      if (bgShape && !strokeAbove && bg?.kind === 'native') {
        bgShape.stroke = strokes.stroke; // one shape: fill + stroke (stroke drawn right above the fill)
      } else {
        const el = this.shapeElement(`~stroke:${node.id}`, node.name, decision, opacity, null, strokes.stroke);
        strokePlan = this.clipNativeShape(el, node, state, ct, () =>
          ownPaintComposite({ fills: false, strokes: true, effects: false }, ['clip'], 'stroke'),
        );
      }
    } else if (strokes.kind !== 'none') {
      strokePlan = ownPaintComposite({ fills: false, strokes: true, effects: false }, strokeReasons.length ? strokeReasons : ['stroke'], 'stroke');
    }

    if (bgShape && bg) {
      below.unshift(
        this.clipNativeShape(bgShape, node, state, ct, () =>
          ownPaintComposite({ fills: true, strokes: !strokeAbove && bgShape!.stroke !== null, effects: bgEffects }, ['clip'], 'bg'),
        ),
      );
    }
    if (strokePlan) (strokeAbove ? above : below).push(strokePlan);
    return { below, above };
  }

  /** Composite of a frame's own paint (children removed), clipped like the frame itself is. */
  private ownPaintComposite(
    node: SceneNode,
    state: WalkState,
    ct: ClipTest,
    keep: { fills: boolean; strokes: boolean; effects: boolean },
    reasons: RasterReason[],
    suffix: string,
  ): Plan {
    const meta = { id: `~${suffix}:${node.id}`, name: node.name, node };
    if (ct.rounded) {
      const rc = ct.rounded;
      const path = pathFrom(rc.node, node);
      if (path) {
        return this.compositePlan(
          { ancestor: rc.node, keep: [path], stripAncestor: true, target: { path, removeChildren: true, keep } },
          meta,
          pushUnique([...reasons], 'clip'),
          exportedOpacity(rc.opacityAbove ?? 1, rc.node),
          rc.clipAbove ?? state.clip.rect,
        );
      }
    }
    // The clone escapes the clips of the node's ancestors (state.clip): the picture is cropped to them.
    return this.compositePlan(
      { ancestor: node, keep: [], target: { path: [], removeChildren: true, keep } },
      meta,
      reasons,
      exportedOpacity(state.opacity, node),
      state.clip.rect,
    );
  }

  // ── Leaves ──

  private planShape(node: SceneNode, state: WalkState, ct: ClipTest, ellipse: boolean): Plan[] {
    const { ctx } = this;
    const rel = relativeMatrix(ctx.slideInverse, node);
    const d = classifyShape(node, this.mixed, ctx.settings, rel, { ellipse, opacityAbove: state.opacity });
    if (d.kind === 'none') return [];
    if (d.kind === 'raster') return [this.rasterPlan(node, d.reasons, state, ct)];
    if (d.kind === 'image') {
      return this.planImageLayer(node, d, state, ct, (reasons) => this.rasterPlan(node, reasons, state, ct), node.id, true);
    }
    const opacity = state.opacity * opacityOf(node);
    const el = this.shapeElement(node.id, node.name, d, opacity, d.fill, d.stroke);
    return [this.clipNativeShape(el, node, state, ct, () => this.rasterPlan(node, ['clip'], state, ct))];
  }

  /**
   * A native shape under the clip rules: plain rectangles (no stroke / shadow, unrotated) are
   * intersected with the clip; other cut shapes use `fallback` (raster with the clip).
   */
  private clipNativeShape(el: ShapeElement, node: SceneNode, state: WalkState, ct: ClipTest, fallback: () => Plan): Plan {
    if (ct.rounded) {
      const covering = ct.innerPartial ? null : this.coveringRoundedShape(el, node, ct.rounded);
      return covering ? planElement(covering) : fallback();
    }
    if (!ct.innerPartial && !ct.slidePartial) return planElement(el);
    const plain = el.geometry === 'rect' && el.transform.rotation === 0 && !el.stroke && !el.shadow;
    if (plain) {
      const clipRect = ct.innerPartial ? state.clip.rect : state.clip.slide;
      const inter = intersectRects(el.transform, clipRect);
      if (!inter) return { kind: 'group', id: node.id, name: node.name, children: [] }; // nothing left
      return planElement(intersectShape(el, inter));
    }
    return ct.innerPartial ? fallback() : planElement(el);
  }

  private shapeElement(id: string, name: string, d: ShapeDecision, opacity: number, fill: ShapeElement['fill'], stroke: ShapeElement['stroke']): ShapeElement {
    return {
      type: 'shape',
      id,
      name,
      transform: d.transform,
      opacity: clean(opacity),
      shadow: d.shadow,
      geometry: d.geometry,
      cornerRadius: d.geometry === 'roundRect' ? d.radius : 0,
      fill,
      stroke,
    };
  }

  private planLine(node: SceneNode, state: WalkState, ct: ClipTest): Plan[] {
    const { ctx } = this;
    const d = classifyLine(node, this.mixed, relativeMatrix(ctx.slideInverse, node));
    if (d.kind === 'none') return [];
    if (d.kind === 'raster') return [this.rasterPlan(node, d.reasons, state, ct)];
    if (ct.rounded || ct.innerPartial) return [this.rasterPlan(node, ['clip'], state, ct)];
    const el: ShapeElement = {
      type: 'shape',
      id: node.id,
      name: node.name,
      transform: d.transform,
      opacity: clean(state.opacity * opacityOf(node)),
      shadow: d.shadow,
      geometry: 'line',
      cornerRadius: 0,
      fill: null,
      stroke: d.stroke,
    };
    return [planElement(el)];
  }

  private async planText(node: TextNode, state: WalkState, ct: ClipTest): Promise<Plan[]> {
    const { ctx } = this;
    const d = classifyText(node, this.mixed, relativeMatrix(ctx.slideInverse, node), state.opacity);
    if (d.kind === 'none') return [];
    const reasons = [...d.reasons];
    if ((ct.innerPartial || ct.rounded) && ctx.settings.clippedText === 'rasterize') pushUnique(reasons, 'clip');
    if (reasons.length > 0) return [this.rasterPlan(node, reasons, state, ct)];
    this.reportTextWarnings(node, d);
    await this.resolveLineHeights(d.paragraphs);
    return [planElement(textElement(node, d, state.opacity * opacityOf(node)))];
  }

  /** AUTO line heights → measured px (when a measurer is configured and the font loads). */
  private async resolveLineHeights(paragraphs: TextParagraph[]): Promise<void> {
    const measure = this.ctx.measureLineHeight;
    if (measure) await resolveAutoLineHeights(paragraphs, measure);
  }

  /** Native text that may not match Figma: missing fonts, vertical trim, truncation. */
  private reportTextWarnings(node: TextNode, d: ReturnType<typeof classifyText>): void {
    const { report } = this.ctx;
    if (d.hasMissingFont) {
      const fonts = d.fonts.map((f) => `${f.family} ${f.style}`).join(', ');
      report.warning('missing-font', `"${node.name}" uses a font missing in Figma (${fonts}); the text box may not match.`, nodeRef(node));
    }
    const n = node as unknown as { leadingTrim?: unknown; textTruncation?: unknown };
    if (n.leadingTrim === 'CAP_HEIGHT') {
      report.warning('text-leading-trim', `"${node.name}" uses vertical trim, which PowerPoint does not support; the text may sit lower.`, nodeRef(node));
    }
    if (n.textTruncation === 'ENDING') {
      report.warning('text-truncated', `"${node.name}" is truncated with an ellipsis in Figma; PowerPoint shows the full text.`, nodeRef(node));
    }
  }

  // ── Images ──

  /**
   * One IMAGE fill → native picture with the original bytes (+ stroke overlay). `fallback(reasons)`
   * produces the raster plan when the image cannot be native.
   */
  private planImageLayer(
    node: SceneNode,
    d: ShapeDecision,
    state: WalkState,
    ct: ClipTest,
    fallback: (reasons: RasterReason[]) => Plan,
    id: string,
    withStroke: boolean,
  ): Plan[] {
    const { ctx } = this;
    const paint = d.imagePaint!;
    const reasons = imagePaintReasons(paint);
    // Frame backgrounds draw their stroke separately (planOwnPaint).
    const strokes = withStroke ? analyzeStrokes(node, this.mixed) : ({ kind: 'none' } as const);
    if (strokes.kind === 'raster') pushUnique(reasons, ...strokes.reasons);
    if (!paint.imageHash) pushUnique(reasons, 'image-format');
    if (paint.scaleMode === 'FIT' && d.geometry === 'ellipse') pushUnique(reasons, 'image-fill-mode');

    // Rounded clip: native only for an image exactly covering the rounded frame (card images), and only
    // when nothing of it paints outside its box (the frame cuts an outer shadow / outer stroke there).
    let geometry = d.geometry;
    let radius = d.radius;
    if (ct.rounded) {
      const rc = ct.rounded;
      const cover = this.coversRoundedFrame(node, rc);
      const uniform = rc.radii.every((r) => Math.abs(r - rc.radii[0]) < 1e-6);
      const paintsOutside = d.shadow?.type === 'outer' || (strokes.kind === 'native' && strokes.stroke.align !== 'inside');
      if (cover && uniform && geometry !== 'ellipse' && !paintsOutside) {
        geometry = 'roundRect';
        radius = clean(Math.max(radius, rc.radii[0]));
      } else pushUnique(reasons, 'clip');
    }
    const rotatedCut = ct.innerPartial && d.transform.rotation !== 0;
    if (rotatedCut || (ct.innerPartial && strokes.kind === 'native')) pushUnique(reasons, 'clip');
    // An outer shadow reaching past a clipping frame is cut there by Figma; natively it would not be.
    if (ct.innerPartial && d.shadow?.type === 'outer') pushUnique(reasons, 'clip');
    // A crop redraws the ellipse / rounded corners / shadow on the CROPPED box: a picture that keeps its
    // shape (or shadow) and is cut by a clipping frame is rasterized; one cut only by the slide edge
    // stays whole (PowerPoint clips at the slide edge itself). FIT pictures (sub-box) are checked in the job.
    const fit = paint.scaleMode === 'FIT';
    const keepsShape = (!fit && geometry !== 'rect') || d.shadow !== null;
    const cutByFrame = (t: Transform) =>
      ct.innerPartial && state.clip.inner !== null && t.rotation === 0 && !containsRect(state.clip.inner, t);
    if (keepsShape && !fit && cutByFrame(d.transform)) pushUnique(reasons, 'clip');
    if (reasons.length > 0) return [fallback(reasons)];

    const opacityLayer = state.opacity * opacityOf(node);
    const clipRect = ct.innerPartial ? state.clip.rect : ct.slidePartial ? state.clip.slide : null;
    const { width, height } = sizeOf(node);
    const hash = paint.imageHash!;
    const meta = { id, name: node.name };
    const strokeEl: ShapeElement | null =
      strokes.kind === 'native'
        ? {
            type: 'shape',
            id: `~stroke:${node.id}`,
            name: node.name,
            transform: d.transform,
            opacity: clean(opacityLayer),
            shadow: null,
            geometry,
            cornerRadius: geometry === 'roundRect' ? radius : 0,
            fill: null,
            stroke: strokes.stroke,
          }
        : null;

    // Reserved now so a read failure is reported in walk order.
    const readSlot = ctx.report.reserve();
    const job = planJob(`image ${node.name}`, async () => {
      let info: ImageInfo | null;
      try {
        info = await this.loadImage(hash);
      } catch (e) {
        // Unreadable bytes cost this layer its original image, not the whole export: Figma's own
        // render of the layer (raster fallback) is used instead.
        if (isCancelledError(e)) throw e;
        const message = e instanceof Error ? e.message : String(e);
        readSlot.fill(
          ctx.report.entry(
            'warning',
            'image-unreadable',
            `The image of "${node.name}" could not be read (${message}); the layer was rasterized instead.`,
            nodeRef(node),
          ),
        );
        info = null;
      }
      const fallbackPlan = (r: RasterReason[]) => fallback(r);
      if (!info || !info.assetId) return this.runFallback(fallbackPlan(['image-format']));
      const placement = computeImageCrop(paint.scaleMode, width, height, info.width, info.height, paint.imageTransform);
      if (!placement) return this.runFallback(fallbackPlan(['image-fill-mode']));
      if (paint.scaleMode === 'FIT' && geometry === 'roundRect') {
        const reaches = reachesRoundedCorner(
          { node, inverse: IDENTITY, width, height, radii: [radius, radius, radius, radius] },
          placement.box,
        );
        if (reaches) return this.runFallback(fallbackPlan(['image-fill-mode']));
      }
      let transform = subRectTransform(d.transform, placement.box);
      let crop = placement.crop;
      // Never cropped (see above); a FIT sub-box with a shadow cut by a clipping frame is rasterized.
      if (clipRect && keepsShape && cutByFrame(transform)) return this.runFallback(fallbackPlan(['clip']));
      ctx.assets.noteDisplaySize(info.assetId, placement.displayWidth, placement.displayHeight);
      if (clipRect && !keepsShape) {
        const cropped = cropPictureToRect(transform, crop, clipRect);
        if (cropped) {
          transform = cropped.transform;
          crop = cropped.crop;
        } else if (transform.rotation === 0) return []; // nothing visible
      }
      const el: ImageElement = {
        type: 'image',
        id: meta.id,
        name: meta.name,
        transform,
        opacity: clean(opacityLayer * (paint.opacity ?? 1)),
        shadow: d.shadow,
        assetId: info.assetId,
        svgAssetId: null,
        crop,
        geometry: fit ? 'rect' : geometry,
        cornerRadius: !fit && geometry === 'roundRect' ? radius : 0,
      };
      return strokeEl ? [el, strokeEl] : [el];
    });
    return [job];
  }

  /**
   * A rect / roundRect exactly covering a rounded clipping frame (e.g. a full-size inner frame) is
   * clipped to the frame's own rounded shape: it stays native with the larger radius, as long as
   * nothing of it paints outside its box (no outer shadow, stroke inside only).
   */
  private coveringRoundedShape(el: ShapeElement, node: SceneNode, rc: RoundedClip): ShapeElement | null {
    const uniform = rc.radii.every((r) => Math.abs(r - rc.radii[0]) < 1e-6);
    if (!uniform || (el.geometry !== 'rect' && el.geometry !== 'roundRect')) return null;
    if (el.shadow?.type === 'outer' || (el.stroke && el.stroke.align !== 'inside')) return null;
    if (!this.coversRoundedFrame(node, rc)) return null;
    return { ...el, geometry: 'roundRect', cornerRadius: clean(Math.max(el.cornerRadius, rc.radii[0])) };
  }

  /** The image layer's box equals the rounded clipping frame's box (frame-local, within tolerance). */
  private coversRoundedFrame(node: SceneNode, rc: RoundedClip): boolean {
    const { width, height } = sizeOf(node);
    const local = transformedBoxBounds(multiply(rc.inverse, absoluteTransformOf(node)), width, height);
    return rectsEqual(local, { x: 0, y: 0, w: rc.width, h: rc.height });
  }

  /**
   * Bytes + size of a Figma image (shared across slides). Rejects when the bytes cannot be read — for
   * the first caller only: the cache keeps `null` (never a rejected promise), so later layers with the
   * same image fall back without trying again.
   */
  private loadImage(hash: string): Promise<ImageInfo | null> {
    const { ctx } = this;
    const cached = ctx.images.get(hash);
    if (cached) return cached;
    const p = (async (): Promise<ImageInfo | null> => {
      const image = ctx.env.getImageByHash(hash);
      if (!image) return null;
      const [bytes, size] = await Promise.all([image.getBytesAsync(), image.getSizeAsync()]);
      const mime = sniffImageMime(bytes);
      if (!mime) return { assetId: null, width: size.width, height: size.height };
      const png = mime === 'image/png' ? readPngInfo(bytes) : null;
      const assetId = ctx.assets.add(
        {
          mime,
          role: 'image-fill',
          data: bytes,
          width: size.width,
          height: size.height,
          hasAlpha: mime === 'image/png' ? (png?.hasAlpha ?? true) : mime === 'image/gif',
        },
        imageKey(hash),
      );
      return { assetId, width: size.width, height: size.height };
    })();
    ctx.images.set(
      hash,
      p.catch(() => null),
    );
    return p;
  }

  /** Run a fallback plan inside a job (image fallbacks are decided after loading the bytes). */
  private async runFallback(plan: Plan): Promise<Element[]> {
    if (plan.kind === 'job') return plan.job.run();
    if (plan.kind === 'element') return [plan.element];
    return [];
  }

  // ── Raster ──

  /**
   * Rasterize `node` as one picture: a plain export in place — already clipped by Figma, placed at
   * its render bounds, not cropped again — or, when it reaches into a rounded corner of a clipping
   * frame, a composite with that frame.
   */
  rasterPlan(node: SceneNode, reasons: RasterReason[], state: WalkState, ct: ClipTest): Plan {
    const meta: Meta = { id: node.id, name: node.name, node };
    if (ct.rounded) {
      const rc = ct.rounded;
      const path = pathFrom(rc.node, node);
      if (path) {
        return this.compositePlan(
          { ancestor: rc.node, keep: [path], stripAncestor: true },
          { ...meta, id: `~clip:${node.id}` },
          pushUnique([...reasons], 'clip'),
          exportedOpacity(rc.opacityAbove ?? 1, rc.node),
          rc.clipAbove ?? state.clip.rect,
        );
      }
    }
    // A rectangular clip is applied by Figma itself: not a rasterization reason by itself.
    const allReasons = [...reasons];
    const svg = wantsSvg(allReasons);
    const { ctx } = this;
    const slot = ctx.report.reserve();
    return planJob(`raster ${node.name}`, async () => {
      const picture = await this.safeExport(node, slot, () =>
        exportPicture(rasterContext(ctx), node, { role: svg ? 'vector-fallback' : 'raster', svg }),
      );
      if (!picture) return [];
      // Only what Figma did not clip: the slide edge of a non-clipping root, or — for the rare
      // bounding-box fallback, whose bitmap Figma's render-bounds clip does not describe — the full clip.
      const clip = picture.absoluteBounds ? state.clip.rect : ctx.rootClips ? null : ctx.slideRect;
      const el = pictureElement(ctx, meta, picture, exportedOpacity(state.opacity, node), allReasons, clip);
      if (el) slot.fill(ctx.report.rasterizedEntry(nodeRef(node), allReasons));
      return el ? [el] : [];
    });
  }

  /**
   * Composite picture. `clipAbove` = the clips of the cloned ancestor's own ancestors (slide px): the
   * clone at the page root is clipped by itself only, so the picture is cropped to them.
   */
  private compositePlan(spec: CompositeSpec, meta: Meta, reasons: RasterReason[], opacity: number, clipAbove: Rect | null): Plan {
    const { ctx } = this;
    const slot = ctx.report.reserve();
    return planJob(`composite ${meta.name}`, async () => {
      const result = await this.safeExport(meta.node, slot, () => exportComposite(rasterContext(ctx), spec, 'raster'));
      if (!result) return [];
      const el = pictureElement(ctx, meta, result, opacity, reasons, clipAbove);
      if (el) slot.fill(ctx.report.rasterizedEntry(nodeRef(meta.node), reasons));
      return el ? [el] : [];
    });
  }

  /** Export errors of single layers are reported and skipped; cancellation propagates. */
  private async safeExport<T>(node: SceneNode, slot: ReportSlot, run: () => Promise<T>): Promise<T | null> {
    throwIfCancelled(this.ctx.isCancelled);
    try {
      return await run();
    } catch (e) {
      if (isCancelledError(e)) throw e;
      const message = e instanceof Error ? e.message : String(e);
      slot.fill(this.ctx.report.entry('warning', 'export-failed', `"${node.name}" could not be exported and was skipped (${message}).`, nodeRef(node)));
      return null;
    }
  }
}

/** A plain rectangle intersected with the clip (a linear gradient keeps its look on the new box). */
export function intersectShape(el: ShapeElement, inter: Rect): ShapeElement {
  const t = el.transform;
  const box: Transform = { ...t, x: clean(inter.x), y: clean(inter.y), w: clean(inter.w), h: clean(inter.h) };
  let fill = el.fill;
  if (fill && fill.type === 'linear-gradient' && t.w > 0 && t.h > 0) {
    // Old normalized coords u = (x − ox)/ow; new box x = nx + u'·nw → u = (nx − ox)/ow + u'·nw/ow.
    // A flipped box runs its local axis the other way (u = (ox + ow − x)/ow), so the offset is measured
    // from the far edge: u = (ox + ow − nx − nw)/ow + u'·nw/ow. (Plain rects are unrotated.)
    const g = fill.gradientTransform;
    const offX = t.flipH ? (t.x + t.w - inter.x - inter.w) / t.w : (inter.x - t.x) / t.w;
    const offY = t.flipV ? (t.y + t.h - inter.y - inter.h) / t.h : (inter.y - t.y) / t.h;
    const s: Matrix = [
      [inter.w / t.w, 0, offX],
      [0, inter.h / t.h, offY],
    ];
    fill = { ...fill, gradientTransform: multiply(g, s) };
  }
  return { ...el, transform: box, fill };
}

/** Slide background: the root's single visible SOLID fill, opaque, normal blend, square corners. */
export function slideBackground(root: SceneNode, mixed: symbol): SolidFill | null {
  if (opacityOf(root) < 1) return null;
  const visible = visiblePaints(fillsOf(root, mixed));
  if (visible.length !== 1) return null;
  const p = visible[0];
  if (p.type !== 'SOLID' || (p.opacity ?? 1) < 1 || !isNormalBlend(p.blendMode)) return null;
  if (!isNormalBlend(blendModeOf(root))) return null;
  const radius = uniformRadiusOf(root, mixed);
  if (radius === null || radius > 0) return null;
  return { type: 'solid', color: { r: clean(p.color.r), g: clean(p.color.g), b: clean(p.color.b), a: 1 } };
}

export function textElement(node: TextNode, d: ReturnType<typeof classifyText>, opacity: number): TextElement {
  return {
    type: 'text',
    id: node.id,
    name: node.name,
    transform: d.transform,
    opacity: clean(opacity),
    shadow: d.shadow,
    verticalAlign: d.verticalAlign,
    autoResize: d.autoResize,
    paragraphs: d.paragraphs,
  };
}

