/**
 * Public entry of the extractor: frames → IR, streamed slide by slide.
 *
 *   const result = await extractDeck(frames, { settings, onSlide, onProgress, isCancelled });
 *
 * - `onSlide` receives each slide with only the assets it introduced (the UI accumulates them).
 * - Cancellation is checked at every yield (`CONFIG.export.yieldEveryNodes`) and before every export;
 *   it rejects with `ExtractCancelledError` (see `isCancelledError`).
 * - Every temporary node is removed before `extractDeck` settles, whatever happens.
 * Pages of the frames must be loaded by the caller (`documentAccess: dynamic-page`).
 */
import { CONFIG } from '../config';
import type { Asset, Deck, DeckMeta, ReportEntry, Slide } from '../ir/types';
import { IR_VERSION } from '../ir/types';
import type { ExportSettings } from '../shared/settings';
import { AssetStore } from './assets';
import { createFigmaEnv, type FigmaEnv } from './figma-env';
import { IdRegistry } from './plan';
import { throwIfCancelled, type CancelCheck } from './pool';
import { TempNodes } from './raster';
import { extractSlide } from './slide';
import type { ImageCache } from './walker';

export { isCancelledError, ExtractCancelledError } from './pool';
export { TempNodes } from './raster';
export { createFigmaEnv } from './figma-env';
export type { FigmaEnv } from './figma-env';

export interface ExtractProgress {
  /** 0-based index of the slide being extracted. */
  slideIndex: number;
  slideCount: number;
  phase: 'walk' | 'export';
  /** Layers visited on the current slide. */
  nodesVisited: number;
  /** Export jobs finished / planned on the current slide (phase 'export'). */
  jobsDone: number;
  jobsTotal: number;
}

export interface ExtractedSlideEvent {
  index: number;
  total: number;
  slide: Slide;
  /** Assets first used by this slide (or re-sent with a larger display size). */
  assets: Asset[];
}

export interface ExtractDeckOptions {
  settings: ExportSettings;
  /** Figma side effects; defaults to the real plugin API. */
  env?: FigmaEnv;
  /** Registry of temporary nodes (pass one to clean up from outside, e.g. on plugin close). */
  temp?: TempNodes;
  isCancelled?: CancelCheck;
  onProgress?: (p: ExtractProgress) => void;
  onSlide?: (e: ExtractedSlideEvent) => void | Promise<void>;
}

export interface ExtractDeckResult {
  slides: Slide[];
  assets: Record<string, Asset>;
  report: ReportEntry[];
}

export async function extractDeck(frames: readonly SceneNode[], options: ExtractDeckOptions): Promise<ExtractDeckResult> {
  const env = options.env ?? createFigmaEnv();
  const temp = options.temp ?? new TempNodes(env);
  const assets = new AssetStore();
  const ids = new IdRegistry();
  const images: ImageCache = new Map();
  const slides: Slide[] = [];
  const report: ReportEntry[] = [];
  const total = frames.length;
  try {
    for (let index = 0; index < total; index++) {
      throwIfCancelled(options.isCancelled);
      const frame = frames[index];
      let nodesVisited = 0;
      const progress = (phase: ExtractProgress['phase'], jobsDone: number, jobsTotal: number) =>
        options.onProgress?.({ slideIndex: index, slideCount: total, phase, nodesVisited, jobsDone, jobsTotal });
      progress('walk', 0, 0);
      const result = await extractSlide(frame, {
        env,
        settings: options.settings,
        assets,
        temp,
        images,
        ids,
        isCancelled: options.isCancelled,
        onVisit: (visited) => {
          nodesVisited = visited;
          if (visited % Math.max(1, CONFIG.extract.progressEveryNodes) === 0) progress('walk', 0, 0);
        },
        onJobDone: (done, jobs) => progress('export', done, jobs),
      });
      slides.push(result.slide);
      report.push(...result.report);
      if (options.onSlide) await options.onSlide({ index, total, slide: result.slide, assets: assets.takeNew() });
    }
    return { slides, assets: assets.toRecord(), report };
  } finally {
    temp.removeAll();
  }
}

/** Assemble a complete IR deck (IR JSON export, tests). */
export function toDeck(meta: DeckMeta, result: ExtractDeckResult): Deck {
  return { irVersion: IR_VERSION, meta, slides: result.slides, assets: result.assets, report: result.report };
}
