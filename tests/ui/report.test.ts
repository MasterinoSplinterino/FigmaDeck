import { beforeAll, describe, expect, it } from 'vitest';
import type { FontReportItem } from '../../src/build/api';
import { CONFIG } from '../../src/config';
import type { ReportEntry } from '../../src/ir/types';
import { setLang } from '../../src/ui/i18n';
import { emptyImageStats } from '../../src/ui/images';
import {
  RASTER_REASONS,
  buildReportModel,
  dedupeText,
  entryText,
  fontFaceText,
  imagesSummary,
  imagesThreadNote,
  reasonHistogram,
  reportToText,
  sizeChangeText,
  type ExportOutcome,
  type ImageStats,
} from '../../src/ui/report';

const e = (o: Partial<ReportEntry> & Pick<ReportEntry, 'level' | 'code' | 'slideId'>): ReportEntry => ({
  slideName: `Slide ${o.slideId}`,
  message: `${o.code} message`,
  ...o,
});

const ENTRIES: ReportEntry[] = [
  e({ level: 'raster', code: 'rasterized', slideId: 's2', nodeId: '1', nodeName: 'Blob', nodeType: 'ELLIPSE', reasons: ['gradient', 'blur'] }),
  e({ level: 'raster', code: 'rasterized', slideId: 's1', nodeId: '2', nodeName: 'Icon', nodeType: 'VECTOR', reasons: ['vector'] }),
  e({ level: 'raster', code: 'rasterized', slideId: 's2', nodeId: '3', nodeName: 'Logo', nodeType: 'VECTOR', reasons: ['vector'] }),
  e({ level: 'skipped', code: 'outside-clip', slideId: 's2', nodeName: 'Item 14' }),
  e({ level: 'skipped', code: 'outside-clip', slideId: 's2', nodeName: 'Item 15' }),
  e({ level: 'skipped', code: 'outside-clip', slideId: 's1', nodeName: 'Offscreen' }),
  e({ level: 'warning', code: 'missing-font', slideId: 's1', nodeName: 'Caption', message: 'Caption uses a missing font' }),
  e({ level: 'warning', code: 'brand-new-code', slideId: 's3', message: 'Something unusual happened.' }),
  e({ level: 'info', code: 'slide-scaled', slideId: 's3', message: 'Slide scaled to 80.8%' }),
  e({ level: 'raster', code: 'rasterized', slideId: 'gone', nodeName: 'Orphan', reasons: ['mask'] }),
];

const FONTS: FontReportItem[] = [
  { family: 'Inter', style: 'Bold', face: 'Inter', bold: true, italic: false, overridden: false, runs: 3 },
  { family: 'Arial', style: 'Italic', face: 'Arial', bold: false, italic: true, overridden: false, runs: 1 },
  { family: 'Inter', style: 'Black', face: 'Inter Heavy', bold: false, italic: false, overridden: true, runs: 2 },
];

beforeAll(() => setLang('en'));

describe('RASTER_REASONS', () => {
  it('lists every reason once', () => {
    expect(new Set(RASTER_REASONS).size).toBe(RASTER_REASONS.length);
    expect(RASTER_REASONS).toContain('exact-mode');
    expect(RASTER_REASONS).toContain('text-feature');
    expect(RASTER_REASONS).toContain('unsupported-paint');
    expect(RASTER_REASONS).toContain('setting');
  });
});

describe('buildReportModel', () => {
  const model = buildReportModel(ENTRIES, FONTS, ['s1', 's2', 's3']);

  it('groups rasterized layers by slide in export order; unknown slides last', () => {
    expect(model.raster.map((g) => [g.slideId, g.slideNumber, g.items.map((i) => i.nodeName)])).toEqual([
      ['s1', 1, ['Icon']],
      ['s2', 2, ['Blob', 'Logo']],
      ['gone', 0, ['Orphan']],
    ]);
    expect(model.raster[1].items[0].reasons).toEqual(['gradient', 'blur']);
    expect(model.rasterCount).toBe(4);
  });

  it('counts skipped layers per slide', () => {
    expect(model.skipped.map((g) => [g.slideId, g.items.length])).toEqual([
      ['s1', 1],
      ['s2', 2],
    ]);
    expect(model.skippedCount).toBe(3);
  });

  it('separates warnings and notes', () => {
    expect(model.warnings.map((w) => w.code)).toEqual(['missing-font', 'brand-new-code']);
    expect(model.infos.map((w) => w.code)).toEqual(['slide-scaled']);
  });

  it('sorts fonts by family, then style (input untouched)', () => {
    expect(model.fonts.map((f) => `${f.family}/${f.style}`)).toEqual(['Arial/Italic', 'Inter/Black', 'Inter/Bold']);
    expect(FONTS[0].family).toBe('Inter');
  });

  it('reasonHistogram counts reasons, most frequent first', () => {
    expect(reasonHistogram(model)).toEqual([
      { reason: 'vector', count: 2 },
      { reason: 'gradient', count: 1 },
      { reason: 'blur', count: 1 },
      { reason: 'mask', count: 1 },
    ]);
  });

  it('empty input → empty model', () => {
    const m = buildReportModel([], [], []);
    expect(m).toEqual({ raster: [], skipped: [], warnings: [], infos: [], fonts: [], rasterCount: 0, skippedCount: 0 });
  });
});

describe('text helpers', () => {
  it('entryText localizes known codes and keeps unknown messages', () => {
    expect(entryText(ENTRIES[6])).toBe('Caption: Uses a font that’s missing in Figma; the text may not match');
    expect(entryText(ENTRIES[7])).toBe('Something unusual happened.');
    expect(entryText(ENTRIES[8])).toBe('Slide was scaled to fit the presentation size');
  });

  it('fontFaceText shows the B / I attributes', () => {
    expect(fontFaceText(FONTS[0])).toBe('Inter (B)');
    expect(fontFaceText({ face: 'X', bold: true, italic: true })).toBe('X (B I)');
    expect(fontFaceText(FONTS[2])).toBe('Inter Heavy');
  });
});

describe('reportToText', () => {
  const outcome: ExportOutcome = {
    format: 'pptx',
    fileName: 'Deck.pptx',
    mime: 'application/x',
    data: new Uint8Array(2048),
    durationMs: 3400,
    slideCount: 3,
    slideIds: ['s1', 's2', 's3'],
    stats: { slides: 3, texts: 10, shapes: 4, images: 5, groups: 1 },
    fonts: FONTS,
    entries: ENTRIES,
    images: {
      ...emptyImageStats('balanced'),
      examined: 4,
      downscaled: 1,
      methods: { original: 1, jpeg: 1, 'palette-exact': 0, 'palette-lossy': 2, lossless: 0 },
      bytesBefore: 1000,
      bytesAfter: 290,
      thread: 'worker',
    },
    pdfDedupe: null,
  };

  it('contains the summary, fonts, all rasterized layers with reasons, skipped counts, warnings and notes', () => {
    const text = reportToText(outcome, buildReportModel(outcome.entries, outcome.fonts, outcome.slideIds));
    expect(text).toContain(`${CONFIG.meta.productName} export report`);
    expect(text).not.toContain('FigmaDeck');
    expect(text).toContain('Deck.pptx (PowerPoint — editable)');
    expect(text).toContain('Slides: 3');
    expect(text).toContain('File size: 2 KB');
    expect(text).toContain('Time: 3.4 s');
    expect(text).toContain('Text boxes: 10');
    expect(text).toContain('Images: 4 · 1,000 B → 290 B (\u221271%) · 2 palette, 1 JPEG, 1 unchanged, 1 downscaled');
    expect(text).not.toContain('background worker');
    expect(text).toContain('## Fonts');
    expect(text).toContain('Fonts aren’t embedded');
    expect(text).toContain('- Inter · Black → Inter Heavy [custom mapping]');
    expect(text).toContain('- Inter · Bold → Inter (B)');
    expect(text).toContain('## Rasterized layers (4)');
    expect(text).toContain('Slide 2: Slide s2');
    expect(text).toContain('  - Blob — Gradient, Blur');
    expect(text).toContain('## Skipped layers (3)');
    expect(text).toContain('Slide 2: Slide s2: 2 layers outside the slide or their clipping frames');
    expect(text).toContain('Slide 1: Slide s1: 1 layer outside the slide or its clipping frame');
    expect(text).toContain('## Warnings (2)');
    expect(text).toContain('- Slide s3: Something unusual happened.');
    expect(text).toContain('## Notes (1)');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('vector PDF: no stats, fonts or raster section; merged duplicates and main\'s warnings', () => {
    const warning = e({ level: 'warning', code: 'missing-frame', slideId: 'x', slideName: 'Old intro' });
    const pdf: ExportOutcome = { ...outcome, format: 'pdf', stats: null, fonts: [], entries: [warning], images: null, pdfDedupe: { objects: 58, bytes: 8.4 * 1024 * 1024 } };
    const text = reportToText(pdf, buildReportModel(pdf.entries, [], []));
    expect(text).toContain('(PDF — vector)');
    expect(text).not.toContain('## Fonts');
    expect(text).not.toContain('Text boxes');
    expect(text).not.toContain('Rasterized layers');
    expect(text).toContain('Repeated images and fonts stored once: 58 objects, 8.4 MB saved');
    expect(text).toContain('- Old intro: The frame no longer exists and was skipped');
  });

  it('image PDF keeps the raster section', () => {
    const text = reportToText({ ...outcome, format: 'pdf-image', stats: null, fonts: [] }, buildReportModel([], [], []));
    expect(text).toContain('Nothing was rasterized.');
  });

  it('dedupeText is null when nothing was merged', () => {
    expect(dedupeText(null)).toBeNull();
    expect(dedupeText({ objects: 0, bytes: 0 })).toBeNull();
    setLang('ru');
    try {
      expect(dedupeText({ objects: 3, bytes: 1536 })).toBe('Повторы картинок и шрифтов сохранены один раз: объектов — 3, экономия 1,5 КБ');
    } finally {
      setLang('en');
    }
  });

  it('localizes to Russian', () => {
    setLang('ru');
    try {
      const text = reportToText(outcome, buildReportModel(outcome.entries, outcome.fonts, outcome.slideIds));
      expect(text).toContain(`Отчёт об экспорте ${CONFIG.meta.productName}`);
      expect(text).toContain('Градиент, Размытие');
      expect(text).toContain('2 слоя вне слайда');
    } finally {
      setLang('en');
    }
  });
});

describe('image compression summary', () => {
  const stats = (o: Partial<ImageStats>): ImageStats => ({ ...emptyImageStats('balanced'), ...o });
  const MB = 1024 * 1024;

  it('totals, size change and the methods used', () => {
    const s = stats({
      examined: 12,
      methods: { original: 1, jpeg: 4, 'palette-exact': 2, 'palette-lossy': 3, lossless: 2 },
      bytesBefore: 12.4 * MB,
      bytesAfter: 3.1 * MB,
      thread: 'worker',
    });
    expect(imagesSummary(s)).toBe('Images: 12 · 12.4 MB → 3.1 MB (\u221275%) · 3 palette, 2 exact palette, 4 JPEG, 2 lossless, 1 unchanged');
    expect(imagesThreadNote(s)).toBeNull();
  });

  it('compression off, failures, nothing looked at', () => {
    const off = stats({ compression: 'off', examined: 2, downscaled: 2, methods: { original: 0, jpeg: 1, 'palette-exact': 0, 'palette-lossy': 0, lossless: 1 }, bytesBefore: 2000, bytesAfter: 1000 });
    expect(imagesSummary(off)).toBe('Images: 2 · 2 KB → 1,000 B (\u221250%) · 1 JPEG, 1 lossless, 2 downscaled, compression off');
    const failed = stats({ examined: 1, failed: 1, methods: { original: 1, jpeg: 0, 'palette-exact': 0, 'palette-lossy': 0, lossless: 0 }, bytesBefore: 500, bytesAfter: 500 });
    expect(imagesSummary(failed)).toBe('Images: 1 · 500 B → 500 B (0%) · 1 unchanged, 1 failed');
    expect(imagesSummary(stats({}))).toBeNull();
    expect(imagesSummary(null)).toBeNull();
  });

  it('main-thread note (no Web Worker)', () => {
    const s = stats({ examined: 1, methods: { original: 0, jpeg: 0, 'palette-exact': 1, 'palette-lossy': 0, lossless: 0 }, bytesBefore: 100, bytesAfter: 50, thread: 'main' });
    expect(imagesThreadNote(s)).toContain('without a background worker');
    const outcome = { format: 'pptx', fileName: 'a.pptx', mime: 'x', data: new Uint8Array(1), durationMs: 1, slideCount: 1, slideIds: [], stats: null, fonts: [], entries: [], images: s, pdfDedupe: null } satisfies ExportOutcome;
    expect(reportToText(outcome, buildReportModel([], [], []))).toContain('without a background worker');
  });

  it('sizeChangeText', () => {
    expect(sizeChangeText(1000, 290)).toBe('\u221271%');
    expect(sizeChangeText(1000, 1040)).toBe('+4%');
    expect(sizeChangeText(1000, 1000)).toBe('0%');
    expect(sizeChangeText(0, 0)).toBe('0%');
  });

  it('localizes to Russian', () => {
    setLang('ru');
    try {
      const s = stats({ examined: 5, methods: { original: 0, jpeg: 1, 'palette-exact': 3, 'palette-lossy': 1, lossless: 0 }, bytesBefore: 322 * 1024, bytesAfter: 148 * 1024, thread: 'main' });
      expect(imagesSummary(s)).toBe('Картинки: 5 · 322 КБ → 148 КБ (\u221254\u00a0%) · палитра: 1, точная палитра: 3, JPEG: 1');
      expect(imagesThreadNote(s)).toContain('без фонового потока');
    } finally {
      setLang('en');
    }
  });
});
