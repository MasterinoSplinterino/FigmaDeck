/**
 * Export report model (pure): groups report entries for the report dialog and renders the
 * plain-text version for "Copy report".
 */
import type { BuildResult, FontReportItem } from '../build/api';
import type { RasterReason, ReportEntry } from '../ir/types';
import type { ExportFormat } from '../shared/settings';
import { codeLabel, formatBytes, formatDuration, formatNumber, reasonLabel, t, tp, type MessageKey } from './i18n';
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

export interface ImageStats {
  /** Assets looked at (image fills, backgrounds, rasters). */
  examined: number;
  downscaled: number;
  /** Re-encoded as JPEG. */
  jpeg: number;
  bytesBefore: number;
  bytesAfter: number;
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
  if (outcome.images && (outcome.images.downscaled > 0 || outcome.images.jpeg > 0)) {
    lines.push(`${t('report.imagesOptimized')}: ${outcome.images.downscaled + outcome.images.jpeg}`);
  }
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
