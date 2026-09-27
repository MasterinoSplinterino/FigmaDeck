import { describe, expect, it } from 'vitest';
import {
  addedIds,
  autoScrollDelta,
  insertionIndexAt,
  isNoopMove,
  moveItem,
  movedIndex,
  offsetIndex,
  reconcileSelection,
} from '../../src/ui/reorder';

const L = ['a', 'b', 'c', 'd', 'e'];

describe('moveItem', () => {
  it('moves forward: item lands before the target of the original list', () => {
    expect(moveItem(L, 0, 3)).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(moveItem(L, 1, 5)).toEqual(['a', 'c', 'd', 'e', 'b']);
  });

  it('moves backward', () => {
    expect(moveItem(L, 4, 0)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(moveItem(L, 3, 1)).toEqual(['a', 'd', 'b', 'c', 'e']);
  });

  it('dropping right before or after itself is a no-op', () => {
    expect(moveItem(L, 2, 2)).toEqual(L);
    expect(moveItem(L, 2, 3)).toEqual(L);
    expect(isNoopMove(2, 2)).toBe(true);
    expect(isNoopMove(2, 3)).toBe(true);
    expect(isNoopMove(2, 4)).toBe(false);
    expect(isNoopMove(2, 1)).toBe(false);
  });

  it('never mutates the input and tolerates out-of-range indices', () => {
    const copy = [...L];
    moveItem(L, 0, 4);
    expect(L).toEqual(copy);
    expect(moveItem(L, -1, 2)).toEqual(L);
    expect(moveItem(L, 9, 2)).toEqual(L);
    expect(moveItem(L, 0, 99)).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(moveItem(L, 4, -5)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(moveItem([], 0, 0)).toEqual([]);
  });

  it('is a permutation for every (from, insertBefore) pair', () => {
    for (let from = 0; from < L.length; from++) {
      for (let ins = 0; ins <= L.length; ins++) {
        const out = moveItem(L, from, ins);
        expect([...out].sort()).toEqual([...L].sort());
        expect(out.indexOf(L[from])).toBe(movedIndex(from, ins, L.length));
      }
    }
  });
});

describe('insertionIndexAt', () => {
  const rows = [
    { top: 0, bottom: 80 },
    { top: 80, bottom: 160 },
    { top: 160, bottom: 200 },
  ];
  it('splits each row at its vertical midpoint', () => {
    expect(insertionIndexAt(rows, -10)).toBe(0);
    expect(insertionIndexAt(rows, 39)).toBe(0);
    expect(insertionIndexAt(rows, 41)).toBe(1);
    expect(insertionIndexAt(rows, 119)).toBe(1);
    expect(insertionIndexAt(rows, 121)).toBe(2);
    expect(insertionIndexAt(rows, 181)).toBe(3);
    expect(insertionIndexAt(rows, 1000)).toBe(3);
  });
  it('empty list → 0', () => {
    expect(insertionIndexAt([], 50)).toBe(0);
  });
});

describe('autoScrollDelta', () => {
  it('is zero in the middle and grows towards the edges', () => {
    expect(autoScrollDelta(300, 0, 600, 40, 10)).toBe(0);
    expect(autoScrollDelta(20, 0, 600, 40, 10)).toBe(-5);
    expect(autoScrollDelta(0, 0, 600, 40, 10)).toBe(-10);
    expect(autoScrollDelta(-50, 0, 600, 40, 10)).toBe(-10);
    expect(autoScrollDelta(580, 0, 600, 40, 10)).toBe(5);
    expect(autoScrollDelta(700, 0, 600, 40, 10)).toBe(10);
  });
  it('zone 0 disables scrolling', () => {
    expect(autoScrollDelta(0, 0, 600, 0, 10)).toBe(0);
  });
});

describe('offsetIndex', () => {
  it('clamps to the list', () => {
    expect(offsetIndex(0, -1, 3)).toBe(0);
    expect(offsetIndex(2, 1, 3)).toBe(2);
    expect(offsetIndex(1, 1, 3)).toBe(2);
    expect(offsetIndex(1, Number.MAX_SAFE_INTEGER, 3)).toBe(2);
  });
  it('no selection: down → first, up → last; empty list → -1', () => {
    expect(offsetIndex(-1, 1, 3)).toBe(0);
    expect(offsetIndex(-1, -1, 3)).toBe(2);
    expect(offsetIndex(0, 1, 0)).toBe(-1);
  });
});

describe('reconcileSelection', () => {
  it('keeps a surviving selection', () => {
    expect(reconcileSelection(L, ['e', 'c', 'a'], 'c')).toBe('c');
  });
  it('selects the next neighbour of a removed item, else the previous one', () => {
    expect(reconcileSelection(L, ['a', 'b', 'd', 'e'], 'c')).toBe('d');
    expect(reconcileSelection(L, ['a', 'b', 'c', 'd'], 'e')).toBe('d');
    expect(reconcileSelection(L, ['a', 'e'], 'c')).toBe('e');
  });
  it('selects the first item when nothing was selected, null for an empty list', () => {
    expect(reconcileSelection([], L, null)).toBe('a');
    expect(reconcileSelection(L, [], 'a')).toBeNull();
  });
  it('unknown old selection → first', () => {
    expect(reconcileSelection(['x'], ['b', 'c'], 'zz')).toBe('b');
  });
  it('whole list replaced → item at the old position', () => {
    expect(reconcileSelection(['a', 'b', 'c'], ['x', 'y', 'z'], 'c')).toBe('z');
  });
});

describe('addedIds', () => {
  it('returns new ids in next order', () => {
    expect(addedIds(['a', 'b'], ['c', 'a', 'd', 'b'])).toEqual(['c', 'd']);
  });
});
