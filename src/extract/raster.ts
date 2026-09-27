/**
 * Raster exports and temporary composites.
 *
 * Plain export (verified behaviour, docs/figma-api-notes.md): `exportAsync` PNG at the raster scale
 * (clamped so the longest side stays within `CONFIG.raster.maxSidePx`) renders
 * `absoluteRenderBounds` — shadows / outside strokes included and ALREADY CLIPPED by every ancestor
 * with `clipsContent` — into a `ceil(w·s) × ceil(h·s)` bitmap. The picture is therefore placed at the
 * render bounds' origin with size `png / s` (not `w × h`, which would stretch it by up to 1 px) and
 * is never cropped again for those clips. If the bitmap size does not match the render bounds, the
 * node is exported again with `useAbsoluteBounds: true` and placed at `absoluteBoundingBox`'s origin
 * (size again `png / s`). Vector layers also get an SVG of the same region, its viewport set to the
 * picture box so both images map 1 px = 1 unit.
 *
 * Composite: some pictures need "this node clipped like its ancestor", "these siblings only", "the
 * frame without its children" or "the frame with its native texts hidden". They are exported from a
 * temporary clone of the ancestor:
 *   1. `env.clone` → at the root of the CURRENT page (which may not be the original's page), with
 *      `relativeTransform = original.absoluteTransform`, so the original parent's auto layout is never
 *      touched and the clone is clipped by nothing but itself;
 *   2. every container on a kept path: instances detached (children of instances cannot be removed;
 *      `detachInstance` returns a NEW node, which replaces the tracked one), auto layout switched off
 *      (`layoutMode = 'NONE'` keeps the size and every child position — verified) BEFORE any child is
 *      removed, so nothing reflows;
 *   3. children off the kept paths removed; target / ancestor paints and the paints of every container
 *      a kept path only passes through stripped (their own paint is a separate element; opacity, clip
 *      and radii are kept: they belong to the content); texts hidden with `opacity = 0`
 *      (`visible = false` would reflow);
 *   4. exported (contents only: the page position is irrelevant), removed in `finally`. The region is
 *      mapped from the clone's coordinates back through the ORIGINAL ancestor's absolute transform.
 * Every temporary node is tracked in `TempNodes` so a cancel / error / plugin close removes it too.
 */
import { CONFIG } from '../config';
import type { AssetRole, Matrix, RasterReason, Rect } from '../ir/types';
import type { ExportSettings } from '../shared/settings';
import type { AssetStore } from './assets';
import { isAlive, type FigmaEnv } from './figma-env';
import { invert, multiply, transformRectBounds } from './geometry';
import { absoluteTransformOf, boundingBoxOf, childrenOf, renderBoundsOf } from './node-props';
import { readPngInfo, readSvgSize, setSvgViewport } from './png';

// ─── Temporary nodes ────────────────────────────────────────────────────────

export class TempNodes {
  private readonly nodes = new Set<SceneNode>();

  constructor(private readonly env: FigmaEnv) {}

  /** Register a temporary node and mark it (name + plugin data) so leftovers can be found later. */
  track(node: SceneNode): void {
    this.nodes.add(node);
    try {
      node.name = CONFIG.extract.tempNodeName;
      if (typeof node.setPluginData === 'function') node.setPluginData(CONFIG.extract.tempPluginDataKey, '1');
    } catch {
      // Marking is best effort.
    }
  }

  /** `old` was replaced by `next` (e.g. `detachInstance`). */
  replace(old: SceneNode, next: SceneNode): void {
    this.nodes.delete(old);
    this.track(next);
  }

  /**
   * Remove one temporary node from the document. Never throws. A removed node may stay resolvable
   * (e.g. a COMPONENT keeps answering `getNodeByIdAsync` with `parent === null`), so "gone" means
   * `removed` or parentless, never "not found".
   */
  release(node: SceneNode): void {
    this.nodes.delete(node);
    try {
      if (isAlive(node)) this.env.remove(node);
    } catch {
      // Already gone.
    }
  }

  /** Remove every temporary node still alive (cancel / error / close). */
  removeAll(): void {
    for (const node of [...this.nodes]) this.release(node);
  }

  get count(): number {
    return this.nodes.size;
  }
}

// ─── Plain exports ──────────────────────────────────────────────────────────

export interface RasterContext {
  env: FigmaEnv;
  settings: Pick<ExportSettings, 'rasterScale' | 'svgVectors'>;
  assets: AssetStore;
  temp: TempNodes;
}

export interface ExportedPicture {
  assetId: string;
  svgAssetId: string | null;
  /**
   * Box the bitmap covers, ABSOLUTE canvas px of the original's page: origin = render bounds (or
   * bounding box) origin, size = PNG pixels / `scale`.
   */
  region: Rect;
  /** Export scale actually used (px of bitmap per canvas px). */
  scale: number;
  /**
   * Exported with `useAbsoluteBounds` (bounding-box region): Figma's clip of the render bounds does not
   * describe this bitmap, so the caller crops it to the clip itself.
   */
  absoluteBounds: boolean;
}

export interface PictureOptions {
  role: AssetRole;
  /** Also export an SVG of the same region (vectors; honored only when settings.svgVectors). */
  svg?: boolean;
  /** Export the node's bounding box instead of its render bounds (backgrounds). */
  useAbsoluteBounds?: boolean;
}

/** Export scale: the requested raster scale, lowered so the longest side ≤ maxSidePx. */
export function exportScale(requested: number, region: Rect, maxSidePx: number = CONFIG.raster.maxSidePx): number {
  const longest = Math.max(region.w, region.h);
  if (!(longest > 0)) return requested;
  return Math.min(requested, maxSidePx / longest);
}

/** Figma's bitmap size for a region: `ceil(side × scale)` (float noise tolerated), at least 1 px. */
export function expectedPixels(side: number, scale: number): number {
  return Math.max(1, Math.ceil(side * scale - 1e-6));
}

function sizeMatches(width: number, height: number, region: Rect, scale: number): boolean {
  const tol = CONFIG.raster.boundsTolerancePx * Math.max(1, scale);
  return Math.abs(width - expectedPixels(region.w, scale)) <= tol && Math.abs(height - expectedPixels(region.h, scale)) <= tol;
}

/** Placement box of a bitmap: the region's origin, size = bitmap px / scale (never the region's w/h). */
export function pictureBox(origin: Rect, pixelWidth: number, pixelHeight: number, scale: number): Rect {
  return { x: origin.x, y: origin.y, w: pixelWidth / scale, h: pixelHeight / scale };
}

function isDrawable(r: Rect | null): r is Rect {
  const min = CONFIG.raster.minVisibleSizePx;
  return !!r && r.w > 0 && r.h > 0 && (r.w >= min || r.h >= min);
}

/**
 * Export `node` as PNG (+ optional SVG) into the asset store. Returns `null` when the node renders
 * nothing (render bounds `null`: invisible or clipped away — Figma would return a 1×1 PNG).
 * Throws when Figma fails to export.
 */
export async function exportPicture(ctx: RasterContext, node: SceneNode, opts: PictureOptions): Promise<ExportedPicture | null> {
  let useAbs = !!opts.useAbsoluteBounds;
  let region = useAbs ? boundingBoxOf(node) : renderBoundsOf(node);
  if (!isDrawable(region)) return null;
  let scale = exportScale(ctx.settings.rasterScale, region);
  let png = await ctx.env.exportAsync(node, pngSettings(scale, useAbs));
  let info = readPngInfo(png);
  if (!info) throw new Error(`Figma did not return a PNG for "${node.name}"`);
  if (!useAbs && !sizeMatches(info.width, info.height, region, scale)) {
    // The bitmap does not cover the render bounds (Figma trims / pads in some cases):
    // export the plain bounding box instead, whose origin is unambiguous.
    const box = boundingBoxOf(node);
    if (isDrawable(box)) {
      useAbs = true;
      region = box;
      scale = exportScale(ctx.settings.rasterScale, region);
      png = await ctx.env.exportAsync(node, pngSettings(scale, true));
      info = readPngInfo(png);
      if (!info) throw new Error(`Figma did not return a PNG for "${node.name}"`);
    }
  }
  // Size from the bitmap, not from the region: ceil(w·s)/s ≥ w, placing it at w would squeeze it.
  const placed = pictureBox(region, info.width, info.height, scale);
  const assetId = ctx.assets.add({
    mime: 'image/png',
    role: opts.role,
    data: png,
    width: info.width,
    height: info.height,
    hasAlpha: info.hasAlpha,
    displayWidth: placed.w,
    displayHeight: placed.h,
  });
  let svgAssetId: string | null = null;
  if (opts.svg && ctx.settings.svgVectors) svgAssetId = await exportSvg(ctx, node, placed, useAbs);
  return { assetId, svgAssetId, region: placed, scale, absoluteBounds: useAbs };
}

function pngSettings(scale: number, useAbsoluteBounds: boolean): ExportSettingsImage {
  const s: ExportSettingsImage = { format: 'PNG', constraint: { type: 'SCALE', value: scale } };
  return useAbsoluteBounds ? { ...s, useAbsoluteBounds: true } : s;
}

/**
 * SVG of the same region, or null when it is too big / its size disagrees / Figma fails.
 * Figma writes `width/height/viewBox = ceil(w) × ceil(h)` (1 unit = 1 px from the region origin); the
 * viewport is rewritten to the picture box so the SVG maps exactly like the PNG it replaces.
 */
async function exportSvg(ctx: RasterContext, node: SceneNode, box: Rect, useAbs: boolean): Promise<string | null> {
  const settings: ExportSettingsSVG = {
    format: 'SVG',
    svgOutlineText: CONFIG.extract.svgOutlineText,
    svgIdAttribute: false,
    svgSimplifyStroke: true,
    ...(useAbs ? { useAbsoluteBounds: true } : {}),
  };
  let svg: Uint8Array;
  try {
    svg = await ctx.env.exportAsync(node, settings);
  } catch {
    return null;
  }
  if (svg.length === 0 || svg.length > CONFIG.extract.svgMaxBytes) return null;
  const size = readSvgSize(svg);
  const tol = CONFIG.extract.svgSizeTolerancePx;
  if (!size || Math.abs(size.width - box.w) > tol || Math.abs(size.height - box.h) > tol) return null;
  const fitted = setSvgViewport(svg, box.w, box.h) ?? svg;
  return ctx.assets.add({ mime: 'image/svg+xml', role: 'svg', data: fitted, width: box.w, height: box.h });
}

// ─── Composites ─────────────────────────────────────────────────────────────

export interface PaintKeep {
  fills: boolean;
  strokes: boolean;
  effects: boolean;
}

export interface CompositeSpec {
  /** The node that is cloned. */
  ancestor: SceneNode;
  /**
   * Child-index paths (from `ancestor`) of the subtrees to keep; everything else is removed.
   * `null` keeps all children; `[]` removes all children.
   */
  keep: number[][] | null;
  /** Remove the ancestor's own fills / strokes / effects (it only provides the clip). */
  stripAncestor?: boolean;
  /**
   * Node on a kept path (or the ancestor itself, path `[]`) whose children are removed and whose
   * paints are filtered ("frame own paint").
   */
  target?: { path: number[]; removeChildren: boolean; keep: PaintKeep };
  /** Paths of TEXT nodes to hide (opacity 0) — valid only with `keep: null`. */
  hide?: number[][];
  useAbsoluteBounds?: boolean;
}

export interface CompositeResult extends ExportedPicture {
  /** Per `hide` path: the clone node there was a TEXT and got hidden. */
  hidden: boolean[];
}

type Mutable = SceneNode & {
  relativeTransform?: Matrix;
  layoutMode?: string;
  fills?: readonly Paint[];
  strokes?: readonly Paint[];
  effects?: readonly Effect[];
  opacity?: number;
  visible?: boolean;
};

/**
 * Map kept paths to their indices AFTER pruning (removed siblings shift the indices).
 * Pure; exported for tests.
 */
export function remapPaths(paths: readonly (readonly number[])[], path: readonly number[]): number[] {
  const out: number[] = [];
  let level: (readonly number[])[] = paths.filter((p) => p.length > 0);
  for (let depth = 0; depth < path.length; depth++) {
    if (level.some((p) => p.length === depth)) {
      // A kept path ends above this depth: its subtree is kept whole, indices are unchanged.
      out.push(...path.slice(depth));
      return out;
    }
    const kept = [...new Set(level.map((p) => p[depth]))].sort((a, b) => a - b);
    const newIndex = kept.indexOf(path[depth]);
    out.push(newIndex < 0 ? path[depth] : newIndex);
    level = level.filter((p) => p[depth] === path[depth]);
  }
  return out;
}

export async function exportComposite(ctx: RasterContext, spec: CompositeSpec, role: AssetRole): Promise<CompositeResult | null> {
  const originalTransform = cloneMatrix(absoluteTransformOf(spec.ancestor));
  let root = ctx.env.clone(spec.ancestor);
  ctx.temp.track(root);
  try {
    // At the root of the current page: page-relative = absolute, so the clone's bounds equal the
    // original's (verified) — on ITS page, which may be another one.
    (root as Mutable).relativeTransform = cloneMatrix(originalTransform);

    const replaceRoot = (next: SceneNode) => {
      ctx.temp.replace(root, next);
      root = next;
    };

    if (spec.keep !== null) root = prune(ctx, root, spec.keep, replaceRoot);

    if (spec.target) {
      const path = spec.keep !== null ? remapPaths(spec.keep, spec.target.path) : spec.target.path;
      let target = nodeAt(root, path);
      if (!target) throw new Error('composite: target not found in clone');
      if (spec.target.removeChildren) {
        target = makeEditable(ctx, target, target === root ? replaceRoot : null);
        for (const child of [...childrenOf(target)].reverse()) removeOrHide(ctx, child);
      }
      stripPaint(target, spec.target.keep);
    }

    if (spec.stripAncestor) stripPaint(root, { fills: false, strokes: false, effects: false });

    const hidden: boolean[] = [];
    for (const path of spec.hide ?? []) {
      const n = nodeAt(root, path);
      if (n && n.type === 'TEXT') {
        (n as Mutable).opacity = 0;
        hidden.push(true);
      } else hidden.push(false);
    }

    const picture = await exportPicture(ctx, root, { role, useAbsoluteBounds: spec.useAbsoluteBounds });
    if (!picture) return null;
    const region = mapToOriginal(picture.region, absoluteTransformOf(root), originalTransform);
    return { ...picture, region, hidden };
  } finally {
    ctx.temp.release(root);
  }
}

/**
 * A rect in the clone's absolute coordinates → the original's absolute coordinates:
 * original.absoluteTransform × inverse(clone.absoluteTransform). Identity in the normal case (the
 * clone got the original's transform); guards against a clone that ended up elsewhere (e.g. a detached
 * root, another page's parent) without ever comparing coordinates across pages.
 */
export function mapToOriginal(r: Rect, cloneTransform: Matrix, originalTransform: Matrix): Rect {
  const same = cloneTransform.every((row, i) => row.every((v, j) => Math.abs(v - originalTransform[i][j]) < 1e-9));
  if (same) return r;
  let back: Matrix;
  try {
    back = multiply(originalTransform, invert(cloneTransform));
  } catch {
    return r;
  }
  const mapped = transformRectBounds(back, r);
  // A pure translation keeps the bitmap's pixel size exactly (no float drift in w / h).
  const translation = Math.abs(back[0][0] - 1) < 1e-9 && Math.abs(back[1][1] - 1) < 1e-9 && Math.abs(back[0][1]) < 1e-9 && Math.abs(back[1][0]) < 1e-9;
  return translation ? { x: mapped.x, y: mapped.y, w: r.w, h: r.h } : mapped;
}

function cloneMatrix(m: Matrix): Matrix {
  return [
    [m[0][0], m[0][1], m[0][2]],
    [m[1][0], m[1][1], m[1][2]],
  ];
}

function nodeAt(root: SceneNode, path: readonly number[]): SceneNode | null {
  let n: SceneNode | undefined = root;
  for (const i of path) {
    n = childrenOf(n)[i];
    if (!n) return null;
  }
  return n;
}

/** Detach instances (their children cannot be removed) and switch off auto layout (no reflow). */
function makeEditable(ctx: RasterContext, node: SceneNode, onReplace: ((next: SceneNode) => void) | null): SceneNode {
  let n = node;
  if (n.type === 'INSTANCE') {
    const detached = ctx.env.detachInstance(n);
    if (onReplace) onReplace(detached);
    n = detached;
  }
  const m = n as Mutable;
  if (typeof m.layoutMode === 'string' && m.layoutMode !== 'NONE') {
    try {
      m.layoutMode = 'NONE';
    } catch {
      // Not settable (e.g. special frames); removal may reflow, the region check still holds.
    }
  }
  return n;
}

function removeOrHide(ctx: RasterContext, node: SceneNode): void {
  try {
    ctx.env.remove(node);
  } catch {
    try {
      (node as Mutable).opacity = 0;
    } catch {
      // Leave it; the export shows it.
    }
  }
}

/**
 * Keep only the subtrees on `paths` (top-down, see module comment). Returns the (maybe replaced) node.
 *
 * Containers the kept paths merely pass through (below the cloned root, not the end of a kept path)
 * lose their own fills / strokes / effects: their own paint is a separate element of the slide (native
 * background / stroke or its own composite), so leaving it in would paint it a second time — over the
 * container's other children. Their `clipsContent`, corner radii and opacity stay: the clip shapes the
 * kept content, and the opacity belongs to it (a composite picture gets only the opacity ABOVE the
 * cloned root; everything from the root down is baked into the bitmap exactly once). The root itself
 * is handled by `stripAncestor` / `target`.
 */
function prune(
  ctx: RasterContext,
  node: SceneNode,
  paths: readonly (readonly number[])[],
  onReplace: ((next: SceneNode) => void) | null,
  isRoot = true,
): SceneNode {
  if (paths.some((p) => p.length === 0)) return node; // whole subtree kept
  const n = makeEditable(ctx, node, onReplace);
  if (!isRoot) stripPaint(n, { fills: false, strokes: false, effects: false });
  const kids = [...childrenOf(n)];
  const keptIndices = new Set(paths.map((p) => p[0]));
  for (let i = kids.length - 1; i >= 0; i--) if (!keptIndices.has(i)) removeOrHide(ctx, kids[i]);
  for (const i of [...keptIndices].sort((a, b) => a - b)) {
    const child = kids[i];
    if (!child) continue;
    const sub = paths.filter((p) => p[0] === i).map((p) => p.slice(1));
    // A detached child replaces itself in the parent; nothing to track (only the root is tracked).
    prune(ctx, child, sub, null, false);
  }
  return n;
}

function stripPaint(node: SceneNode, keep: PaintKeep): void {
  const m = node as Mutable;
  try {
    if (!keep.fills && 'fills' in node) m.fills = [];
    if (!keep.strokes && 'strokes' in node) m.strokes = [];
    if (!keep.effects && 'effects' in node) m.effects = [];
  } catch {
    // Some node types refuse paint edits; the export then includes them.
  }
}

/** Reasons for which an SVG is written next to the PNG (pure vector content). */
export function wantsSvg(reasons: readonly RasterReason[]): boolean {
  return reasons.length > 0 && reasons.every((r) => r === 'vector' || r === 'boolean-operation');
}
