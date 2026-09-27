/**
 * Pure helpers for the slide list: drag-and-drop reordering, keyboard selection, and keeping the
 * selection meaningful when the list changes.
 *
 * "Insertion index" = position in the ORIGINAL list before which the dragged item is dropped
 * (0 … length). Dropping an item right before or right after itself is a no-op.
 */

/** Vertical extent of one row, in the same coordinate space as the pointer (px). */
export interface RowExtent {
  top: number;
  bottom: number;
}

/** True when moving `from` to insertion index `insertBefore` does not change the order. */
export function isNoopMove(from: number, insertBefore: number): boolean {
  return insertBefore === from || insertBefore === from + 1;
}

/**
 * Move the item at `from` so it lands before the item that is at `insertBefore` in the original list
 * (`insertBefore === list.length` → to the end). Returns a new array; out-of-range input → copy.
 */
export function moveItem<T>(list: readonly T[], from: number, insertBefore: number): T[] {
  const out = [...list];
  if (from < 0 || from >= list.length) return out;
  const target = Math.max(0, Math.min(list.length, insertBefore));
  if (isNoopMove(from, target)) return out;
  const [item] = out.splice(from, 1);
  out.splice(target > from ? target - 1 : target, 0, item);
  return out;
}

/** Final index of the moved item after `moveItem(list, from, insertBefore)`. */
export function movedIndex(from: number, insertBefore: number, length: number): number {
  const target = Math.max(0, Math.min(length, insertBefore));
  if (isNoopMove(from, target)) return from;
  return target > from ? target - 1 : target;
}

/**
 * Insertion index for a pointer at `y`: before the first row whose vertical midpoint is below the
 * pointer, or `rows.length` when the pointer is past every midpoint.
 */
export function insertionIndexAt(rows: readonly RowExtent[], y: number): number {
  for (let i = 0; i < rows.length; i++) {
    const mid = (rows[i].top + rows[i].bottom) / 2;
    if (y < mid) return i;
  }
  return rows.length;
}

/**
 * Auto-scroll speed (px per frame, signed: − up, + down) while dragging at `y` inside a viewport
 * `[top, bottom]`: grows linearly from 0 at the inner edge of the `zone` to `max` at the border.
 */
export function autoScrollDelta(y: number, top: number, bottom: number, zone: number, max: number): number {
  if (zone <= 0) return 0;
  if (y < top + zone) return -Math.round(max * Math.min(1, (top + zone - y) / zone));
  if (y > bottom - zone) return Math.round(max * Math.min(1, (y - (bottom - zone)) / zone));
  return 0;
}

/** Index after moving the selection by `delta` rows, clamped to the list; -1 for an empty list. */
export function offsetIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, current + delta));
}

/**
 * Which id stays selected after the list changed from `prev` to `next`:
 * - the same id when it still exists;
 * - otherwise the item now at the removed item's old position (or the last one);
 * - the first item when nothing was selected; null for an empty list.
 */
export function reconcileSelection(prev: readonly string[], next: readonly string[], selected: string | null): string | null {
  if (next.length === 0) return null;
  if (selected !== null && next.includes(selected)) return selected;
  if (selected === null) return next[0];
  const oldIndex = prev.indexOf(selected);
  if (oldIndex < 0) return next[0];
  // Nearest surviving neighbour: the first item after the old position that still exists, else before.
  for (let i = oldIndex + 1; i < prev.length; i++) if (next.includes(prev[i])) return prev[i];
  for (let i = oldIndex - 1; i >= 0; i--) if (next.includes(prev[i])) return prev[i];
  return next[Math.min(oldIndex, next.length - 1)];
}

/** Ids added in `next` compared with `prev` (in `next` order). */
export function addedIds(prev: readonly string[], next: readonly string[]): string[] {
  const before = new Set(prev);
  return next.filter((id) => !before.has(id));
}
