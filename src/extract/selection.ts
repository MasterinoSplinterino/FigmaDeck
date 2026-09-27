/**
 * Main-thread helpers for the deck list: which nodes can be slides, what "Add slides" adds for a
 * selection, persistence format of the deck, canvas-order sort keys. Pure where possible.
 */
import { sortByCanvasOrder, type CanvasItem } from './order';
import { childrenOf, pageOf } from './node-props';

/** Plugin data keys (on `figma.root`) and client storage keys. */
export const STORAGE_KEYS = {
  slides: 'figmadeck.slides',
  title: 'figmadeck.title',
  settings: 'figmadeck.settings',
} as const;

const SLIDE_TYPES = new Set<string>(['FRAME', 'COMPONENT', 'INSTANCE']);
/** Parents under which a frame counts as "top level". A variant's parent is its COMPONENT_SET. */
const TOP_LEVEL_PARENTS = new Set<string>(['PAGE', 'SECTION', 'COMPONENT_SET']);

export type SlideNode = FrameNode | ComponentNode | InstanceNode;

/**
 * A removed COMPONENT stays resolvable by `getNodeByIdAsync` with `parent === null` (verified), so a
 * deleted frame is recognized by `removed` OR a missing parent, not by the lookup failing.
 */
export function isSlideNode(node: BaseNode | null | undefined): node is SlideNode {
  return !!node && SLIDE_TYPES.has(node.type) && !(node as SceneNode).removed && node.parent !== null;
}

/** The top-level slide frame containing `node` (itself when it is one), or null. */
export function topLevelFrameOf(node: BaseNode): SlideNode | null {
  let n: BaseNode = node;
  while (n.parent && !TOP_LEVEL_PARENTS.has(n.parent.type)) n = n.parent;
  if (!n.parent) return null; // reached the document / a page itself
  return isSlideNode(n) ? n : null;
}

/**
 * Frames that "Add slides" takes from a selection: top-level frames as they are, a SECTION's direct
 * frame children, the top-level frame of any nested layer. Deduplicated, in selection order.
 */
export function framesFromSelection(selection: readonly SceneNode[]): SlideNode[] {
  const out: SlideNode[] = [];
  const seen = new Set<string>();
  const add = (n: SlideNode | null) => {
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  };
  for (const node of selection) {
    if (node.type === 'SECTION') {
      for (const child of childrenOf(node)) if (isSlideNode(child)) add(child);
    } else add(topLevelFrameOf(node));
  }
  return out;
}

/** Deck ids from plugin data (tolerates garbage). */
export function parseSlideIds(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
    return out;
  } catch {
    return [];
  }
}

export function serializeSlideIds(ids: readonly string[]): string {
  return JSON.stringify(ids);
}

/** A reorder request must be a permutation of the current deck. */
export function isPermutation(current: readonly string[], next: readonly string[]): boolean {
  if (current.length !== next.length) return false;
  const set = new Set(current);
  const seen = new Set<string>();
  for (const id of next) {
    if (!set.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** Sort key of a frame on the canvas: page index in the document + absolute bounding box. */
export function canvasItemOf(node: SceneNode, pages: readonly PageNode[]): CanvasItem | null {
  const page = pageOf(node);
  const box = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  if (!page || !box) return null;
  return { pageIndex: pages.findIndex((p) => p.id === page.id), x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Sort nodes in canvas order (page, rows, x). Nodes without a position keep their relative order at the end. */
export function sortNodesByCanvas<T extends SceneNode>(nodes: readonly T[], pages: readonly PageNode[]): T[] {
  const placed: Array<CanvasItem & { node: T }> = [];
  const rest: T[] = [];
  for (const node of nodes) {
    const item = canvasItemOf(node, pages);
    if (item) placed.push({ ...item, node });
    else rest.push(node);
  }
  return [...sortByCanvasOrder(placed).map((p) => p.node), ...rest];
}

export interface FontCount {
  family: string;
  style: string;
  count: number;
}

/** Count text segments per Figma font (`getStyledTextSegments(['fontName'])`). */
export function countFonts(texts: readonly TextNode[]): FontCount[] {
  const counts = new Map<string, FontCount>();
  for (const t of texts) {
    if (t.characters.length === 0) continue;
    for (const seg of t.getStyledTextSegments(['fontName'])) {
      const key = `${seg.fontName.family}::${seg.fontName.style}`;
      const c = counts.get(key);
      if (c) c.count++;
      else counts.set(key, { family: seg.fontName.family, style: seg.fontName.style, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
}

/** The node and all its ancestors up to (excluding) `stop` are visible. */
export function isVisibleWithin(node: BaseNode, stop: BaseNode): boolean {
  let n: BaseNode | null = node;
  while (n && n !== stop) {
    if ('visible' in n && n.visible === false) return false;
    n = n.parent;
  }
  return true;
}
