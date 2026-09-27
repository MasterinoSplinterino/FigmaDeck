/**
 * postMessage protocol between the plugin main thread (src/main.ts) and the UI iframe (src/ui/).
 * Binary payloads are `Uint8Array` (structured clone, no base64).
 *
 * UI → main:  parent.postMessage({ pluginMessage: msg }, '*')
 * main → UI:  figma.ui.postMessage(msg)
 */
import type { Asset, DeckMeta, ReportEntry, Slide } from '../ir/types';
import type { ExportFormat, ExportSettings } from './settings';

/** A frame that is part of the deck (persisted per document, ordered). */
export interface SlideInfo {
  /** Figma node id. */
  id: string;
  name: string;
  width: number;
  height: number;
  pageId: string;
  pageName: string;
  /** Node no longer exists / is not a frame any more. Shown greyed out, skipped on export. */
  missing?: boolean;
}

export interface SelectionInfo {
  /** Number of frames in the current selection that "Add slides" would add. */
  frameCount: number;
  /** How many of them are already in the deck. */
  alreadyInDeck: number;
}

export interface FontInfo {
  family: string;
  style: string;
  /** Number of text segments using it across the deck. */
  count: number;
  /** Font is missing in Figma (hasMissingFont). */
  missing: boolean;
}

export type ExportPhase = 'extract' | 'images' | 'build' | 'pdf' | 'done';

// ─── UI → main ───────────────────────────────────────────────────────────────

export type UiToMain =
  | { type: 'ui-ready' }
  /** Add frames from the current selection (sections expand to their frames). */
  | { type: 'add-selection' }
  | { type: 'remove-slides'; ids: string[] }
  | { type: 'clear-slides' }
  /** New full order of slide ids. */
  | { type: 'reorder-slides'; ids: string[] }
  /** Re-sort by canvas position (page order, then rows, then x). */
  | { type: 'sort-slides' }
  | { type: 'set-deck-title'; title: string }
  | { type: 'request-thumbnails'; ids: string[] }
  | { type: 'request-preview'; id: string }
  /** Select and zoom to the frame on canvas. */
  | { type: 'focus-slide'; id: string }
  | { type: 'request-fonts' }
  | { type: 'save-settings'; settings: ExportSettings }
  | { type: 'start-export'; format: ExportFormat; settings: ExportSettings }
  | { type: 'cancel-export' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'notify'; message: string; error?: boolean };

// ─── main → UI ───────────────────────────────────────────────────────────────

export type MainToUi =
  | {
      type: 'init';
      slides: SlideInfo[];
      settings: ExportSettings;
      deckTitle: string;
      fileName: string;
      selection: SelectionInfo;
    }
  | { type: 'slides'; slides: SlideInfo[] }
  | { type: 'selection'; selection: SelectionInfo }
  | { type: 'thumbnail'; id: string; bytes: Uint8Array }
  | { type: 'preview'; id: string; bytes: Uint8Array }
  /** The preview could not be rendered (frame missing / export failed) — stop the spinner. */
  | { type: 'preview-failed'; id: string; message?: string }
  | { type: 'fonts'; fonts: FontInfo[] }
  | { type: 'export-started'; format: ExportFormat; total: number }
  | {
      type: 'export-progress';
      phase: ExportPhase;
      done: number;
      total: number;
      /** English fallback text; the UI localizes from the numeric fields when present. */
      label: string;
      /** 1-based slide being processed. */
      slide?: number;
      /** Layers visited so far in the current slide. */
      layers?: number;
      /** Raster export jobs finished / planned in the current slide. */
      jobsDone?: number;
      jobsTotal?: number;
    }
  /**
   * One extracted slide + the assets it introduced. An asset id already sent earlier may be sent
   * again (e.g. with a larger displayWidth/displayHeight): the UI replaces the stored asset by id.
   */
  | { type: 'export-slide'; index: number; total: number; slide: Slide; assets: Asset[] }
  /** All slides were sent; the UI now builds the file. */
  | { type: 'export-extracted'; meta: DeckMeta; report: ReportEntry[] }
  | { type: 'export-pdf-page'; index: number; total: number; name: string; bytes: Uint8Array }
  | { type: 'export-pdf-done'; meta: DeckMeta; report: ReportEntry[] }
  | { type: 'export-cancelled' }
  | { type: 'export-error'; message: string }
  | { type: 'toast'; message: string; error?: boolean };
