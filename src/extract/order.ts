/**
 * Default slide order = canvas reading order: page order first, then rows (top edges within
 * `CONFIG.order.rowToleranceRatio` × the smaller height of the row's first frame and the candidate),
 * then left to right. Pure; positions are absolute canvas px.
 */
import { CONFIG } from '../config';

export interface CanvasItem {
  /** Index of the frame's page in `figma.root.children`. */
  pageIndex: number;
  /** Absolute bounding box, px. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Returns a new array sorted in canvas reading order (stable for equal positions). */
export function sortByCanvasOrder<T extends CanvasItem>(
  items: readonly T[],
  rowToleranceRatio: number = CONFIG.order.rowToleranceRatio,
): T[] {
  const indexed = items.map((item, index) => ({ item, index }));
  const byPage = new Map<number, typeof indexed>();
  for (const e of indexed) {
    const list = byPage.get(e.item.pageIndex);
    if (list) list.push(e);
    else byPage.set(e.item.pageIndex, [e]);
  }
  const out: T[] = [];
  for (const pageIndex of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(pageIndex)!;
    list.sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x || a.index - b.index);
    let row: typeof indexed = [];
    const flush = () => {
      row.sort((a, b) => a.item.x - b.item.x || a.item.y - b.item.y || a.index - b.index);
      for (const e of row) out.push(e.item);
      row = [];
    };
    for (const e of list) {
      const anchor = row[0];
      if (anchor) {
        const tolerance = rowToleranceRatio * Math.min(Math.max(0, anchor.item.height), Math.max(0, e.item.height));
        if (e.item.y - anchor.item.y >= tolerance) flush();
      }
      row.push(e);
    }
    flush();
  }
  return out;
}
