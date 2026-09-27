/**
 * Defensive, typed accessors for node properties that only some node types have.
 * Returning neutral values for absent properties keeps the classifiers simple and lets tests use
 * partial mock nodes.
 */
import type { Matrix, Rect } from '../ir/types';

/** Node types whose children are walked (containers). `SLOT` is a frame-like node. */
const CONTAINER_TYPES = new Set<string>(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'SLOT']);
/** Frame-like containers: own fills / strokes / corner radius / clipsContent. */
const FRAME_LIKE_TYPES = new Set<string>(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'SLOT']);

export function isContainer(node: SceneNode): boolean {
  return CONTAINER_TYPES.has(node.type);
}

export function isFrameLike(node: SceneNode): boolean {
  return FRAME_LIKE_TYPES.has(node.type);
}

export function childrenOf(node: BaseNode): readonly SceneNode[] {
  return 'children' in node && Array.isArray(node.children) ? (node.children as readonly SceneNode[]) : [];
}

export function opacityOf(node: SceneNode): number {
  return 'opacity' in node && typeof node.opacity === 'number' ? node.opacity : 1;
}

/** Visible flag and non-zero opacity (the node paints something at all). */
export function isRendered(node: SceneNode): boolean {
  return node.visible !== false && opacityOf(node) > 0;
}

export function blendModeOf(node: SceneNode): BlendMode | undefined {
  return 'blendMode' in node ? node.blendMode : undefined;
}

export function isMaskNode(node: SceneNode): boolean {
  return 'isMask' in node && node.isMask === true;
}

/** Fills; `'mixed'` for text with per-range fills (use styled segments then). */
export function fillsOf(node: SceneNode, mixed: symbol): readonly Paint[] | 'mixed' {
  if (!('fills' in node)) return [];
  const fills = node.fills as unknown;
  if (fills === mixed) return 'mixed';
  return Array.isArray(fills) ? (fills as readonly Paint[]) : [];
}

export function strokesOf(node: SceneNode): readonly Paint[] {
  return 'strokes' in node && Array.isArray(node.strokes) ? node.strokes : [];
}

export function effectsOf(node: SceneNode): readonly Effect[] {
  return 'effects' in node && Array.isArray(node.effects) ? node.effects : [];
}

export function clipsContentOf(node: SceneNode): boolean {
  return 'clipsContent' in node && node.clipsContent === true;
}

/**
 * Corner radii [topLeft, topRight, bottomRight, bottomLeft] in px, or `null` for nodes without corners.
 * `cornerRadius` is `figma.mixed` when the corners differ; the individual radii are then authoritative.
 */
export function cornerRadiiOf(node: SceneNode, mixed: symbol): [number, number, number, number] | null {
  if (!('cornerRadius' in node)) return null;
  const n = node as unknown as {
    cornerRadius?: unknown;
    topLeftRadius?: unknown;
    topRightRadius?: unknown;
    bottomRightRadius?: unknown;
    bottomLeftRadius?: unknown;
  };
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? Math.max(0, v) : 0);
  const uniform = typeof n.cornerRadius === 'number' && n.cornerRadius !== (mixed as unknown) ? num(n.cornerRadius) : null;
  if (typeof n.topLeftRadius === 'number') {
    const radii: [number, number, number, number] = [
      num(n.topLeftRadius),
      num(n.topRightRadius),
      num(n.bottomRightRadius),
      num(n.bottomLeftRadius),
    ];
    // A uniform `cornerRadius` wins only when the individual radii agree with it.
    return uniform !== null && radii.every((r) => r === uniform) ? [uniform, uniform, uniform, uniform] : radii;
  }
  const r = uniform ?? 0;
  return [r, r, r, r];
}

/** Uniform radius (px) or `null` when the corners differ. Nodes without corners → 0. */
export function uniformRadiusOf(node: SceneNode, mixed: symbol): number | null {
  const radii = cornerRadiiOf(node, mixed);
  if (!radii) return 0;
  return radii.every((r) => Math.abs(r - radii[0]) < 1e-6) ? Math.max(0, radii[0]) : null;
}

/** `absoluteRenderBounds` (null when nothing is rendered). */
export function renderBoundsOf(node: SceneNode): Rect | null {
  const r = 'absoluteRenderBounds' in node ? node.absoluteRenderBounds : null;
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}

export function boundingBoxOf(node: SceneNode): Rect | null {
  const r = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}

export function sizeOf(node: SceneNode): { width: number; height: number } {
  return {
    width: 'width' in node && typeof node.width === 'number' ? node.width : 0,
    height: 'height' in node && typeof node.height === 'number' ? node.height : 0,
  };
}

export function absoluteTransformOf(node: SceneNode): Matrix {
  return 'absoluteTransform' in node
    ? (node.absoluteTransform as Matrix)
    : [
        [1, 0, 0],
        [0, 1, 0],
      ];
}

/** Nearest PAGE ancestor. */
export function pageOf(node: BaseNode): PageNode | null {
  let n: BaseNode | null = node;
  while (n && n.type !== 'PAGE') n = n.parent;
  return n && n.type === 'PAGE' ? n : null;
}

/** Child indices from `ancestor` down to `node`, or `null` when `node` is not inside `ancestor`. */
export function pathFrom(ancestor: BaseNode, node: BaseNode): number[] | null {
  const path: number[] = [];
  let n: BaseNode = node;
  while (n !== ancestor) {
    const parent: BaseNode | null = n.parent;
    if (!parent) return null;
    const index = childrenOf(parent).indexOf(n as SceneNode);
    if (index < 0) return null;
    path.unshift(index);
    n = parent;
  }
  return path;
}

/** Follow child indices. */
export function nodeAtPath(root: SceneNode, path: readonly number[]): SceneNode | null {
  let n: SceneNode | undefined = root;
  for (const i of path) {
    n = childrenOf(n)[i];
    if (!n) return null;
  }
  return n;
}
