/**
 * Deck state of the UI (slides, selection, settings, fonts) as a pure reducer.
 * Dialogs, toasts, images and export progress are component state (see components/App.tsx).
 */
import type { FontInfo, MainToUi, SelectionInfo, SlideInfo } from '../shared/messages';
import { DEFAULT_SETTINGS, normalizeSettings, type ExportSettings } from '../shared/settings';
import { moveItem, offsetIndex, reconcileSelection } from './reorder';

export interface DeckState {
  /** `init` received. */
  ready: boolean;
  slides: SlideInfo[];
  /** Selected slide in the sidebar (shown in the big preview). */
  selectedId: string | null;
  /** Current Figma selection (what "Add slides" would add). */
  selection: SelectionInfo;
  settings: ExportSettings;
  /** Deck title as edited by the user; empty → `fileName`. */
  deckTitle: string;
  /** Figma file name. */
  fileName: string;
  /** Fonts used by the deck (`null` until `fonts` arrives). */
  fonts: FontInfo[] | null;
}

export const INITIAL_STATE: DeckState = {
  ready: false,
  slides: [],
  selectedId: null,
  selection: { frameCount: 0, alreadyInDeck: 0 },
  settings: DEFAULT_SETTINGS,
  deckTitle: '',
  fileName: '',
  fonts: null,
};

export type DeckAction =
  | { type: 'main'; msg: MainToUi }
  | { type: 'select'; id: string | null }
  /** Move the selection by N rows (keyboard ↑ / ↓). */
  | { type: 'select-offset'; delta: number }
  /** Optimistic local reorder (drag and drop); main confirms with `slides`. */
  | { type: 'move'; from: number; insertBefore: number }
  /** Optimistic local removal; main confirms with `slides`. */
  | { type: 'remove'; ids: string[] }
  | { type: 'settings'; patch: Partial<ExportSettings> }
  | { type: 'replace-settings'; settings: ExportSettings }
  | { type: 'title'; title: string };

function withSlides(state: DeckState, slides: SlideInfo[]): DeckState {
  const selectedId = reconcileSelection(
    state.slides.map((s) => s.id),
    slides.map((s) => s.id),
    state.selectedId,
  );
  return { ...state, slides, selectedId };
}

function applyMain(state: DeckState, msg: MainToUi): DeckState {
  switch (msg.type) {
    case 'init': {
      const base: DeckState = {
        ...state,
        ready: true,
        settings: normalizeSettings(msg.settings),
        deckTitle: msg.deckTitle,
        fileName: msg.fileName,
        selection: msg.selection,
      };
      return withSlides(base, msg.slides);
    }
    case 'slides':
      return withSlides(state, msg.slides);
    case 'selection':
      return { ...state, selection: msg.selection };
    case 'fonts':
      return { ...state, fonts: msg.fonts };
    default:
      return state;
  }
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case 'main':
      return applyMain(state, action.msg);
    case 'select':
      if (action.id !== null && !state.slides.some((s) => s.id === action.id)) return state;
      return { ...state, selectedId: action.id };
    case 'select-offset': {
      const current = state.slides.findIndex((s) => s.id === state.selectedId);
      const next = offsetIndex(current, action.delta, state.slides.length);
      return { ...state, selectedId: next < 0 ? null : state.slides[next].id };
    }
    case 'move':
      return { ...state, slides: moveItem(state.slides, action.from, action.insertBefore) };
    case 'remove': {
      const drop = new Set(action.ids);
      return withSlides(state, state.slides.filter((s) => !drop.has(s.id)));
    }
    case 'settings':
      return { ...state, settings: normalizeSettings({ ...state.settings, ...action.patch }) };
    case 'replace-settings':
      return { ...state, settings: normalizeSettings(action.settings) };
    case 'title':
      return { ...state, deckTitle: action.title };
  }
}

/** Title shown in the top bar and used for file names. */
export function effectiveTitle(state: Pick<DeckState, 'deckTitle' | 'fileName'>): string {
  return state.deckTitle.trim() || state.fileName.trim();
}

/** Frames of the current Figma selection that are not in the deck yet. */
export function newFramesInSelection(selection: SelectionInfo): number {
  return Math.max(0, selection.frameCount - selection.alreadyInDeck);
}

/** Slides that can be exported (not missing). */
export function exportableCount(slides: readonly SlideInfo[]): number {
  return slides.filter((s) => !s.missing).length;
}
