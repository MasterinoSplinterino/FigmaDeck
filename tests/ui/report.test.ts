import { beforeAll, describe, expect, it } from 'vitest';
import type { FontReportItem } from '../../src/build/api';
import type { ReportEntry } from '../../src/ir/types';
import { setLang } from '../../src/ui/i18n';
import { RASTER_REASONS, buildReportModel, entryText, fontFaceText, reasonHistogram, reportToText, type ExportOutcome } from '../../src/ui/report';

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
    expect(entryText(ENTRIES[6])).toBe('Caption: Uses a font missing in Figma; the text box may not match');
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
    images: { examined: 3, downscaled: 1, jpeg: 1, bytesBefore: 1000, bytesAfter: 400 },
  };

  it('contains the summary, fonts, all rasterized layers with reasons, skipped counts, warnings and notes', () => {
    const text = reportToText(outcome, buildReportModel(outcome.entries, outcome.fonts, outcome.slideIds));
    expect(text).toContain('FigmaDeck export report');
    expect(text).toContain('Deck.pptx');
    expect(text).toContain('Slides: 3');
    expect(text).toContain('File size: 2 KB');
    expect(text).toContain('Time: 3.4 s');
    expect(text).toContain('Text boxes: 10');
    expect(text).toContain('Images optimized: 2');
    expect(text).toContain('## Fonts');
    expect(text).toContain('Fonts are not embedded');
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

  it('PDF outcome without stats or fonts', () => {
    const pdf: ExportOutcome = { ...outcome, format: 'pdf', stats: null, fonts: [], entries: [], images: null };
    const text = reportToText(pdf, buildReportModel([], [], []));
    expect(text).not.toContain('## Fonts');
    expect(text).not.toContain('Text boxes');
    expect(text).toContain('Nothing was rasterized.');
  });

  it('localizes to Russian', () => {
    setLang('ru');
    try {
      const text = reportToText(outcome, buildReportModel(outcome.entries, outcome.fonts, outcome.slideIds));
      expect(text).toContain('Отчёт об экспорте FigmaDeck');
      expect(text).toContain('Градиент, Размытие');
      expect(text).toContain('2 слоя вне слайда');
    } finally {
      setLang('en');
    }
  });
});
