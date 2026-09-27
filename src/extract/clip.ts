/**
 * Clip state that travels down the walk.
 *
 * Figma already clips `absoluteRenderBounds` and default exports by every ancestor with `clipsContent`
 * (docs/figma-api-notes.md), so rasters exported in place need no crop. The state is needed for what
 * Figma does not clip for us: NATIVE elements (text, shapes, image fills with `srcRect`) and
 * composites, whose clone at the page root escapes the original ancestors' clips.
 *
 * - `rect`: slide bounds ∩ every axis-aligned clipping ancestor (frames with `clipsContent`), slide px.
 * - `inner`: the same intersection WITHOUT the slide bounds (null = no clipping ancestor below the
 *   root). Content cut only by the slide edge needs no rasterization: PowerPoint clips at the slide
 *   edge itself; pictures are still cropped there to save bytes.
 * - `rounded`: clipping ancestors with rounded corners. Content reaching into a cut-off corner can
 *   only be reproduced by rasterizing it together with that ancestor (temporary composite).
 *
 * Pure (no Figma API).
 */
import { CONFIG } from '../config';
import type { Matrix, Rect } from '../ir/types';
import { containsRect, intersectRects, transformRectBounds } from './geometry';

export interface RoundedClip {
  /** The clipping frame. */
  node: SceneNode;
  /** inverse(node.absoluteTransform) */
  inverse: Matrix;
  /** Frame size, px. */
  width: number;
  height: number;
  /** [topLeft, topRight, bottomRight, bottomLeft], px, clamped to half the shorter side. */
  radii: [number, number, number, number];
  /** Effective opacity of the frame's ancestors (a composite of the frame bakes in the rest). */
  opacityAbove?: number;
  /**
   * Clip rect (slide px) of the frame's ancestors: a composite of the frame is a clone at the page
   * root, clipped by the frame itself but not by them, so its picture is cropped to this rect.
   */
  clipAbove?: Rect;
}

export interface ClipState {
  slide: Rect;
  rect: Rect;
  inner: Rect | null;
  rounded: readonly RoundedClip[];
}

export function initialClip(slide: Rect): ClipState {
  return { slide, rect: slide, inner: null, rounded: [] };
}

/**
 * Clip state below a clipping frame. `frameRect` = the frame box in slide px (axis-aligned, i.e. the
 * frame is not rotated by a non-quarter angle); `rounded` when its corners are rounded.
 * `isRoot` frames only contribute their rounded corners (their rect is the slide).
 */
export function pushClip(state: ClipState, frameRect: Rect | null, rounded: RoundedClip | null, isRoot = false): ClipState {
  let rect = state.rect;
  let inner = state.inner;
  if (frameRect && !isRoot) {
    rect = intersectRects(rect, frameRect) ?? { x: frameRect.x, y: frameRect.y, w: 0, h: 0 };
    inner = inner ? (intersectRects(inner, frameRect) ?? { x: frameRect.x, y: frameRect.y, w: 0, h: 0 }) : frameRect;
  }
  return { slide: state.slide, rect, inner, rounded: rounded ? [...state.rounded, rounded] : state.rounded };
}

export function makeRoundedClip(
  node: SceneNode,
  inverse: Matrix,
  width: number,
  height: number,
  radii: readonly [number, number, number, number],
): RoundedClip | null {
  const max = Math.max(0, Math.min(width, height) / 2);
  const r = radii.map((v) => Math.min(Math.max(0, v), max)) as [number, number, number, number];
  return r.some((v) => v > CONFIG.extract.geometryEpsilonPx) ? { node, inverse, width, height, radii: r } : null;
}

/**
 * Does content with absolute render bounds `abs` paint into the area a rounded corner cuts off?
 * Per corner: intersect the content's local bounds with the corner square; the point of that
 * intersection farthest from the arc center must lie inside the arc.
 */
export function reachesRoundedCorner(rc: RoundedClip, abs: Rect): boolean {
  const eps = CONFIG.extract.geometryEpsilonPx;
  const local = transformRectBounds(rc.inverse, abs);
  const { width: w, height: h } = rc;
  const [tl, tr, br, bl] = rc.radii;
  const corners: Array<{ r: number; square: Rect; cx: number; cy: number; far: (i: Rect) => [number, number] }> = [
    { r: tl, square: { x: 0, y: 0, w: tl, h: tl }, cx: tl, cy: tl, far: (i) => [i.x, i.y] },
    { r: tr, square: { x: w - tr, y: 0, w: tr, h: tr }, cx: w - tr, cy: tr, far: (i) => [i.x + i.w, i.y] },
    { r: br, square: { x: w - br, y: h - br, w: br, h: br }, cx: w - br, cy: h - br, far: (i) => [i.x + i.w, i.y + i.h] },
    { r: bl, square: { x: 0, y: h - bl, w: bl, h: bl }, cx: bl, cy: h - bl, far: (i) => [i.x, i.y + i.h] },
  ];
  for (const c of corners) {
    if (c.r <= eps) continue;
    const i = intersectRects(local, c.square);
    if (!i) continue;
    const [px, py] = c.far(i);
    if (Math.hypot(px - c.cx, py - c.cy) > c.r + eps) return true;
  }
  return false;
}

export interface ClipTest {
  /** Nothing of the content is inside the clip. */
  outside: boolean;
  /** Cut by a clipping ancestor below the root. */
  innerPartial: boolean;
  /** Cut by the slide edge. */
  slidePartial: boolean;
  /** Outermost rounded clipping ancestor whose cut-off corner the content reaches (or null). */
  rounded: RoundedClip | null;
}

/** `visual` = render bounds in slide px; `abs` = the same in absolute px (for rounded tests). */
export function testClip(state: ClipState, visual: Rect, abs: Rect | null): ClipTest {
  const outside = intersectRects(state.rect, visual) === null;
  let rounded: RoundedClip | null = null;
  if (!outside && abs) {
    for (const rc of state.rounded) {
      if (reachesRoundedCorner(rc, abs)) {
        rounded = rc;
        break;
      }
    }
  }
  return {
    outside,
    innerPartial: !outside && state.inner !== null && !containsRect(state.inner, visual),
    slidePartial: !outside && !containsRect(state.slide, visual),
    rounded,
  };
}
