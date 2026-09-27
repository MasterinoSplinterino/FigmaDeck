/**
 * Export report model (pure): groups report entries for the report dialog and renders the
 * plain-text version for "Copy report".
 */
import type { BuildResult, FontReportItem } from '../build/api';
import type { AssetRole, RasterReason, ReportEntry } from '../ir/types';
import type { ExportFormat, ExportSettings } from '../shared/settings';
import type { CompressMethod } from './compress-job';
import { codeLabel, formatBytes, formatDuration, formatNumber, formatPercent, reasonLabel, t, tp, type Lang, type MessageKey } from './i18n';
import type { DedupeStats } from './pdf';

/** Every RasterReason, checked at compile time (a new reason in ir/types.ts must be added here). */
const REASONS_SET = {
  'exact-mode': true,
  'image-mode': true,
  vector: true,
  'boolean-operation': true,
  gradient: true,
  'gradient-text': true,
  'image-fill-mode': true,
  'image-filters': true,
  'image-format': true,
  'multiple-fills': true,
  'mixed-radii': true,
  'blend-mode': true,
  mask: true,
  blur: true,
  effects: true,
  stroke: true,
  transform: true,
  clip: true,
  'group-opacity': true,
  'unsupported-node': true,
  'unsupported-paint': true,
  setting: true,
  'text-feature': true,
} satisfies Record<RasterReason, true>;

export const RASTER_REASONS = Object.keys(REASONS_SET) as RasterReason[];

/** One compressed asset (src/ui/images.ts). */
export interface AssetStat {
  id: string;
  role: AssetRole;
  /** What the asset ended up as (`original` = bytes kept as exported). */
  method: CompressMethod;
  bytesBefore: number;
  bytesAfter: number;
  ms: number;
  /** Size of the kept bitmap (px). */
  width: number;
  height: number;
  /** A downscaled bitmap was kept. */
  downscaled: boolean;
  /** Distinct colours counted by the pixel job (up to its limit). */
  colors?: number;
  /** Processing failed; the asset was kept as it was. */
  failed?: boolean;
}

export interface ImageStats {
  compression: ExportSettings['compression'];
  /** Assets looked at (image fills, backgrounds, rasters, vector fallbacks). */
  examined: number;
  /** Kept at a smaller size (oversized image fills). */
  downscaled: number;
  failed: number;
  /** Assets per outcome. */
  methods: Record<CompressMethod, number>;
  bytesBefore: number;
  bytesAfter: number;
  /** Time of the whole images phase. */
  ms: number;
  /** Where the pixel jobs ran (`main` = no Web Worker could be started); null when none ran. */
  thread: 'worker' | 'main' | null;
  items: AssetStat[];
}

/** Order of the methods in the summary line. */
const METHOD_ORDER: readonly CompressMethod[] = ['palette-lossy', 'palette-exact', 'jpeg', 'lossless', 'original'];

const METHOD_KEY: Readonly<Record<CompressMethod, MessageKey>> = {
  'palette-lossy': 'report.method.palette-lossy',
  'palette-exact': 'report.method.palette-exact',
  jpeg: 'report.method.jpeg',
  lossless: 'report.method.lossless',
  original: 'report.method.original',
};

/** "−71%" (U+2212), "+4%" or "0%": the size change of the images. */
export function sizeChangeText(before: number, after: number, lang?: Lang): string {
  if (!(before > 0)) return formatPercent(0, lang, 0);
  const change = (after - before) / before;
  const text = formatPercent(Math.abs(change), lang, 0);
  if (Math.round(Math.abs(change) * 100) === 0) return text;
  return `${change < 0 ? '\u2212' : '+'}${text}`;
}

/**
 * "Images: 12 · 12.4 MB → 3.1 MB (−75%) · 3 palette, 2 exact palette, 4 JPEG, 1 lossless, 2 unchanged",
 * or null when no image was looked at.
 */
export function imagesSummary(stats: ImageStats | null, lang?: Lang): string | null {
  if (!stats || stats.examined === 0) return null;
  const head = t('report.imagesLine', { n: formatNumber(stats.examined, lang), before: formatBytes(stats.bytesBefore, lang), after: formatBytes(stats.bytesAfter, lang), pct: sizeChangeText(stats.bytesBefore, stats.bytesAfter, lang) }, lang);
  const parts = METHOD_ORDER.filter((m) => stats.methods[m] > 0).map((m) => t(METHOD_KEY[m], { n: formatNumber(stats.methods[m], lang) }, lang));
  if (stats.downscaled > 0) parts.push(t('report.imagesDownscaled', { n: formatNumber(stats.downscaled, lang) }, lang));
  if (stats.failed > 0) parts.push(t('report.imagesFailed', { n: formatNumber(stats.failed, lang) }, lang));
  if (stats.compression === 'off') parts.push(t('report.imagesCompressionOff', undefined, lang));
  return parts.length > 0 ? `${head} · ${parts.join(', ')}` : head;
}

/** Note shown when the pixel compression ran without a Web Worker, else null. */
export function imagesThreadNote(stats: ImageStats | null, lang?: Lang): string | null {
  return stats?.thread === 'main' ? t('report.imagesMainThread', undefined, lang) : null;
}

/** Everything the report dialog needs about a finished export. */
export interface ExportOutcome {
  format: ExportFormat;
  fileName: string;
  mime: string;
  data: Uint8Array;
  durationMs: number;
  slideCount: number;
  /** Exported slide ids in order (groups the report by slide). */
  slideIds: string[];
  /** Builder counters (PPTX formats only). */
  stats: BuildResult['stats'] | null;
  fonts: FontReportItem[];
  /** Extraction report + build report. */
  entries: ReportEntry[];
  images: ImageStats | null;
  /** Vector PDF only: duplicate resources merged when the per-frame PDFs were combined. */
  pdfDedupe: DedupeStats | null;
}

/** Menu / report label of an export target. */
export const FORMAT_LABEL: Readonly<Record<ExportFormat, MessageKey>> = {
  pptx: 'export.pptx',
  'pptx-image': 'export.pptxImage',
  pdf: 'export.pdf',
  'pdf-image': 'export.pdfImage',
  'ir-json': 'export.irJson',
};

/** Whether the report lists rasterized layers (not for Figma's own vector PDF). */
export function showsRasterSection(format: ExportFormat): boolean {
  return format !== 'pdf';
}

/** "Repeated images and fonts stored once: 12 objects, 8.4 MB saved", or null when nothing was merged. */
export function dedupeText(stats: DedupeStats | null): string | null {
  if (!stats || stats.objects === 0) return null;
  return t('report.pdfDedupe', { n: formatNumber(stats.objects), size: formatBytes(stats.bytes) });
}

export interface RasterItem {
  nodeId?: string;
  nodeName: string;
  nodeType?: string;
  reasons: RasterReason[];
}

export interface SlideGroup<T> {
  slideId: string;
  slideName: string;
  /** 1-based position in the export order (0 when the slide is not part of the order). */
  slideNumber: number;
  items: T[];
}

export interface ReportModel {
  raster: SlideGroup<RasterItem>[];
  /** Skipped layers per slide (count = items.length). */
  skipped: SlideGroup<ReportEntry>[];
  warnings: ReportEntry[];
  infos: ReportEntry[];
  /** Fonts sorted by family, then style. */
  fonts: FontReportItem[];
  rasterCount: number;
  skippedCount: number;
}

function groupBySlide<T>(entries: readonly ReportEntry[], order: readonly string[], map: (e: ReportEntry) => T): SlideGroup<T>[] {
  const groups = new Map<string, SlideGroup<T>>();
  for (const e of entries) {
    let g = groups.get(e.slideId);
    if (!g) {
      const idx = order.indexOf(e.slideId);
      g = { slideId: e.slideId, slideName: e.slideName, slideNumber: idx + 1, items: [] };
      groups.set(e.slideId, g);
    }
    g.items.push(map(e));
  }
  // Slides in export order; unknown slides (not in `order`) keep their first-seen order at the end.
  return [...groups.values()].sort((a, b) => (a.slideNumber || Infinity) - (b.slideNumber || Infinity));
}

/**
 * Group report entries: rasterized layers and skipped layers by slide (in `slideOrder`), warnings
 * and notes as flat lists. `slideOrder` = exported slide ids in order.
 */
export function buildReportModel(entries: readonly ReportEntry[], fonts: readonly FontReportItem[], slideOrder: readonly string[]): ReportModel {
  const raster = entries.filter((e) => e.level === 'raster');
  const skipped = entries.filter((e) => e.level === 'skipped');
  return {
    raster: groupBySlide(raster, slideOrder, (e) => ({
      nodeId: e.nodeId,
      nodeName: e.nodeName ?? e.slideName,
      nodeType: e.nodeType,
      reasons: e.reasons ?? [],
    })),
    skipped: groupBySlide(skipped, slideOrder, (e) => e),
    warnings: entries.filter((e) => e.level === 'warning'),
    infos: entries.filter((e) => e.level === 'info'),
    fonts: [...fonts].sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style)),
    rasterCount: raster.length,
    skippedCount: skipped.length,
  };
}

/** Reason counts over all rasterized layers, most frequent first. */
export function reasonHistogram(model: ReportModel): Array<{ reason: RasterReason; count: number }> {
  const counts = new Map<RasterReason, number>();
  for (const g of model.raster) for (const item of g.items) for (const r of item.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

/**
 * Localized one-line text of a warning / note entry: "<layer>: <description>" for known codes,
 * the builder's / extractor's English message otherwise. The slide is shown separately.
 */
export function entryText(e: ReportEntry): string {
  const label = codeLabel(e.code);
  if (!label) return e.message;
  return e.nodeName ? `${e.nodeName}: ${label}` : label;
}

export function fontFaceText(f: Pick<FontReportItem, 'face' | 'bold' | 'italic'>): string {
  const attrs = [f.bold ? 'B' : '', f.italic ? 'I' : ''].filter(Boolean).join(' ');
  return attrs ? `${f.face} (${attrs})` : f.face;
}

function slideTitle(g: SlideGroup<unknown>): string {
  return g.slideNumber > 0 ? t('report.slideLabel', { i: g.slideNumber, name: g.slideName }) : g.slideName;
}

/** Plain-text report for the clipboard (all items, no truncation). */
export function reportToText(outcome: ExportOutcome, model: ReportModel): string {
  const lines: string[] = [];
  lines.push(t('report.textHeader'), `${outcome.fileName} (${t(FORMAT_LABEL[outcome.format])})`, '');
  lines.push(`${t('report.slides')}: ${outcome.slideCount}`);
  lines.push(`${t('report.size')}: ${formatBytes(outcome.data.byteLength)}`);
  lines.push(`${t('report.duration')}: ${formatDuration(outcome.durationMs)}`);
  if (outcome.stats) {
    lines.push(`${t('report.texts')}: ${outcome.stats.texts}`);
    lines.push(`${t('report.shapes')}: ${outcome.stats.shapes}`);
    lines.push(`${t('report.images')}: ${outcome.stats.images}`);
    lines.push(`${t('report.groups')}: ${outcome.stats.groups}`);
  }
  const images = imagesSummary(outcome.images);
  if (images) lines.push(images);
  const threadNote = imagesThreadNote(outcome.images);
  if (threadNote) lines.push(threadNote);
  const dedupe = dedupeText(outcome.pdfDedupe);
  if (dedupe) lines.push(dedupe);

  if (model.fonts.length > 0) {
    lines.push('', `## ${t('report.fonts')}`, t('report.fontsWarning'));
    for (const f of model.fonts) {
      const mark = f.overridden ? ` [${t('report.fontOverridden')}]` : '';
      lines.push(`- ${f.family} · ${f.style} → ${fontFaceText(f)}${mark}`);
    }
  }

  if (showsRasterSection(outcome.format)) {
    lines.push('', `## ${t('report.raster')} (${model.rasterCount})`);
    if (model.raster.length === 0) lines.push(t('report.rasterNone'));
    for (const g of model.raster) {
      lines.push(slideTitle(g));
      for (const item of g.items) {
        const reasons = item.reasons.map((r) => reasonLabel(r)).join(', ');
        lines.push(`  - ${item.nodeName}${reasons ? ` — ${reasons}` : ''}`);
      }
    }
  }

  if (model.skipped.length > 0) {
    lines.push('', `## ${t('report.skipped')} (${model.skippedCount})`);
    for (const g of model.skipped) lines.push(`${slideTitle(g)}: ${tp('report.skippedCount', g.items.length)}`);
  }
  if (model.warnings.length > 0) {
    lines.push('', `## ${t('report.warnings')} (${model.warnings.length})`);
    for (const e of model.warnings) lines.push(`- ${e.slideName}: ${entryText(e)}`);
  }
  if (model.infos.length > 0) {
    lines.push('', `## ${t('report.notes')} (${model.infos.length})`);
    for (const e of model.infos) lines.push(`- ${e.slideName}: ${entryText(e)}`);
  }
  return lines.join('\n') + '\n';
}
