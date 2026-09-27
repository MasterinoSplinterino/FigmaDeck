/**
 * Export progress model for the overlay (pure): which phases a format runs, the overall fraction
 * of the bar, and the localized phase label.
 */
import { CONFIG } from '../config';
import type { ExportFormat } from '../shared/settings';
import { t, type MessageKey } from './i18n';

export type ProgressPhase =
  /** `start-export` sent, nothing received yet. */
  | 'starting'
  /** main: extracting slides (IR formats). */
  | 'extract'
  /** main: exporting PDF pages (vector PDF). */
  | 'pdf'
  /** UI: downscaling / JPEG-encoding images. */
  | 'images'
  /** UI: builder adding slides. */
  | 'build'
  /** UI: builder packaging + post-processing the PPTX. */
  | 'package'
  /** UI: merging PDF pages. */
  | 'merge'
  /** UI: drawing image pages into a PDF. */
  | 'render'
  /** UI: writing the IR JSON. */
  | 'serialize';

export interface ProgressState {
  format: ExportFormat;
  phase: ProgressPhase;
  /** Items finished in this phase. */
  done: number;
  total: number;
  /** Secondary line (e.g. the frame name and layer count sent by main). */
  detail?: string;
  /** "Cancel" was pressed; waiting for the pipeline to stop. */
  cancelling?: boolean;
}

type WeightGroup = keyof typeof CONFIG.ui.progressWeights;

const GROUP_OF: Readonly<Record<Exclude<ProgressPhase, 'starting'>, WeightGroup>> = {
  extract: 'extract',
  pdf: 'pdf',
  images: 'images',
  build: 'build',
  package: 'package',
  serialize: 'package',
  merge: 'merge',
  render: 'merge',
};

/** Weight groups a format goes through, in order. */
export function phaseGroups(format: ExportFormat): WeightGroup[] {
  switch (format) {
    case 'pptx':
    case 'pptx-image':
      return ['extract', 'images', 'build', 'package'];
    case 'pdf':
      return ['pdf', 'merge'];
    case 'pdf-image':
      return ['extract', 'images', 'merge'];
    case 'ir-json':
      return ['extract', 'package'];
  }
}

/** Overall progress 0..1 across the format's phases (weights from CONFIG.ui.progressWeights, renormalized). */
export function overallFraction(p: ProgressState): number {
  if (p.phase === 'starting') return 0;
  const groups = phaseGroups(p.format);
  const weights = groups.map((g) => CONFIG.ui.progressWeights[g]);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const index = groups.indexOf(GROUP_OF[p.phase]);
  if (index < 0) return 0;
  const before = weights.slice(0, index).reduce((a, b) => a + b, 0);
  const within = p.total > 0 ? Math.max(0, Math.min(1, p.done / p.total)) : 0;
  return Math.max(0, Math.min(1, (before + weights[index] * within) / sum));
}

const LABEL_KEY: Readonly<Record<ProgressPhase, MessageKey>> = {
  starting: 'progress.starting',
  extract: 'progress.extract',
  pdf: 'progress.pdfPages',
  images: 'progress.images',
  build: 'progress.build',
  package: 'progress.package',
  merge: 'progress.merge',
  render: 'progress.render',
  serialize: 'progress.serialize',
};

/** "Extracting slide 3 of 10" — `i` is the item in progress (1-based), clamped to the total. */
export function phaseLabel(p: ProgressState): string {
  const n = Math.max(0, p.total);
  const i = Math.min(n, Math.max(1, p.done + 1));
  return t(LABEL_KEY[p.phase], { i, n });
}

export function progressTitle(format: ExportFormat): string {
  switch (format) {
    case 'pptx':
    case 'pptx-image':
      return t('progress.title.pptx');
    case 'pdf':
    case 'pdf-image':
      return t('progress.title.pdf');
    case 'ir-json':
      return t('progress.title.json');
  }
}
