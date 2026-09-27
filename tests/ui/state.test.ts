import { describe, expect, it } from 'vitest';
import type { SlideInfo } from '../../src/shared/messages';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { INITIAL_STATE, deckReducer, effectiveTitle, exportableCount, newFramesInSelection, type DeckState } from '../../src/ui/state';

const slide = (id: string, missing = false): SlideInfo => ({ id, name: `Frame ${id}`, width: 1920, height: 1080, pageId: 'p', pageName: 'Page', ...(missing ? { missing } : {}) });

function initState(ids: string[]): DeckState {
  return deckReducer(INITIAL_STATE, {
    type: 'main',
    msg: { type: 'init', slides: ids.map((id) => slide(id)), settings: DEFAULT_SETTINGS, deckTitle: 'Deck', fileName: 'File', selection: { frameCount: 2, alreadyInDeck: 1 } },
  });
}

describe('deckReducer', () => {
  it('init: ready, first slide selected, settings normalized', () => {
    const s = deckReducer(INITIAL_STATE, {
      type: 'main',
      msg: { type: 'init', slides: [slide('a'), slide('b')], settings: { ...DEFAULT_SETTINGS, rasterScale: 7 as 2 }, deckTitle: 'T', fileName: 'F', selection: { frameCount: 0, alreadyInDeck: 0 } },
    });
    expect(s.ready).toBe(true);
    expect(s.selectedId).toBe('a');
    expect(s.settings.rasterScale).toBe(DEFAULT_SETTINGS.rasterScale);
    expect(s.deckTitle).toBe('T');
    expect(s.fileName).toBe('F');
  });

  it('slides: keeps or moves the selection', () => {
    let s = initState(['a', 'b', 'c']);
    s = deckReducer(s, { type: 'select', id: 'b' });
    s = deckReducer(s, { type: 'main', msg: { type: 'slides', slides: [slide('c'), slide('b')] } });
    expect(s.selectedId).toBe('b');
    s = deckReducer(s, { type: 'main', msg: { type: 'slides', slides: [slide('c')] } });
    expect(s.selectedId).toBe('c');
    s = deckReducer(s, { type: 'main', msg: { type: 'slides', slides: [] } });
    expect(s.selectedId).toBeNull();
  });

  it('select ignores unknown ids; select-offset moves and clamps', () => {
    let s = initState(['a', 'b', 'c']);
    expect(deckReducer(s, { type: 'select', id: 'zz' })).toBe(s);
    s = deckReducer(s, { type: 'select-offset', delta: 1 });
    expect(s.selectedId).toBe('b');
    s = deckReducer(s, { type: 'select-offset', delta: 5 });
    expect(s.selectedId).toBe('c');
    s = deckReducer(s, { type: 'select-offset', delta: -Number.MAX_SAFE_INTEGER });
    expect(s.selectedId).toBe('a');
  });

  it('move reorders optimistically and keeps the selection', () => {
    let s = initState(['a', 'b', 'c', 'd']);
    s = deckReducer(s, { type: 'select', id: 'a' });
    s = deckReducer(s, { type: 'move', from: 0, insertBefore: 3 });
    expect(s.slides.map((x) => x.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(s.selectedId).toBe('a');
  });

  it('remove drops slides and selects the next one', () => {
    let s = initState(['a', 'b', 'c']);
    s = deckReducer(s, { type: 'select', id: 'b' });
    s = deckReducer(s, { type: 'remove', ids: ['b'] });
    expect(s.slides.map((x) => x.id)).toEqual(['a', 'c']);
    expect(s.selectedId).toBe('c');
  });

  it('settings patches are normalized', () => {
    let s = initState(['a']);
    s = deckReducer(s, { type: 'settings', patch: { jpeg: true, jpegQuality: 0.7 } });
    expect(s.settings.jpeg).toBe(true);
    expect(s.settings.jpegQuality).toBe(0.7);
    s = deckReducer(s, { type: 'settings', patch: { widthSlackPercent: 500 } });
    expect(s.settings.widthSlackPercent).toBe(DEFAULT_SETTINGS.widthSlackPercent);
    s = deckReducer(s, { type: 'replace-settings', settings: { ...DEFAULT_SETTINGS, mode: 'exact' } });
    expect(s.settings.mode).toBe('exact');
  });

  it('selection, fonts and title', () => {
    let s = initState(['a']);
    s = deckReducer(s, { type: 'main', msg: { type: 'selection', selection: { frameCount: 4, alreadyInDeck: 1 } } });
    expect(s.selection).toEqual({ frameCount: 4, alreadyInDeck: 1 });
    s = deckReducer(s, { type: 'main', msg: { type: 'fonts', fonts: [{ family: 'Inter', style: 'Bold', count: 2, missing: false }] } });
    expect(s.fonts).toHaveLength(1);
    s = deckReducer(s, { type: 'title', title: 'New' });
    expect(s.deckTitle).toBe('New');
  });

  it('ignores export / image messages', () => {
    const s = initState(['a']);
    expect(deckReducer(s, { type: 'main', msg: { type: 'toast', message: 'x' } })).toBe(s);
    expect(deckReducer(s, { type: 'main', msg: { type: 'export-cancelled' } })).toBe(s);
  });
});

describe('selectors', () => {
  it('effectiveTitle falls back to the file name', () => {
    expect(effectiveTitle({ deckTitle: '  ', fileName: ' File ' })).toBe('File');
    expect(effectiveTitle({ deckTitle: 'Deck', fileName: 'File' })).toBe('Deck');
  });
  it('newFramesInSelection', () => {
    expect(newFramesInSelection({ frameCount: 3, alreadyInDeck: 1 })).toBe(2);
    expect(newFramesInSelection({ frameCount: 1, alreadyInDeck: 3 })).toBe(0);
  });
  it('exportableCount skips missing slides', () => {
    expect(exportableCount([slide('a'), slide('b', true), slide('c')])).toBe(2);
  });
});
