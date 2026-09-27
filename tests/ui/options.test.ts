import { describe, expect, it } from 'vitest';
import { resolveFont } from '../../src/fonts/mapping';
import { DEFAULT_SETTINGS, fontKey, normalizeSettings, type ExportSettings } from '../../src/shared/settings';
import {
  PPTX_MIME,
  applyFontOverride,
  autoFont,
  buildOptionsFromSettings,
  editableMode,
  effectiveFont,
  fileKindOf,
  isIrFormat,
  settingsForFormat,
} from '../../src/ui/options';

const settings = (o: Partial<ExportSettings> = {}): ExportSettings => normalizeSettings({ ...DEFAULT_SETTINGS, ...o });

describe('buildOptionsFromSettings', () => {
  it('maps the builder-relevant settings', () => {
    const o = buildOptionsFromSettings(
      settings({ textCase: 'transform', widthSlackPercent: 4.5, svgVectors: false, preserveGroups: false, fontNaming: 'full', author: ' Ann ', company: 'ACME' }),
      '  Q3 Review ',
    );
    expect(o).toEqual({
      textCase: 'transform',
      widthSlackPercent: 4.5,
      fontOverrides: {},
      fontNaming: 'full',
      svgVectors: false,
      preserveGroups: false,
      title: 'Q3 Review',
      author: 'Ann',
      company: 'ACME',
    });
  });

  it('omits empty metadata and the slide size in frame mode', () => {
    const o = buildOptionsFromSettings(settings({ author: '', company: '  ' }), '');
    expect(o).not.toHaveProperty('title');
    expect(o).not.toHaveProperty('author');
    expect(o).not.toHaveProperty('company');
    expect(o).not.toHaveProperty('slideSize');
  });

  it('passes a custom slide size in inches', () => {
    const o = buildOptionsFromSettings(settings({ slideSizeMode: 'custom', slideWidthIn: 34.575, slideHeightIn: 10.665 }), 'x');
    expect(o.slideSize).toEqual({ widthIn: 34.575, heightIn: 10.665 });
    // A stored custom size is ignored while the mode is "frame".
    expect(buildOptionsFromSettings(settings({ slideSizeMode: 'frame', slideWidthIn: 34.575, slideHeightIn: 10.665 }), 'x')).not.toHaveProperty('slideSize');
  });

  it('passes the font naming rule', () => {
    expect(buildOptionsFromSettings(settings(), 'x').fontNaming).toBe('ribbi');
    expect(buildOptionsFromSettings(settings({ fontNaming: 'full' }), 'x').fontNaming).toBe('full');
  });

  it('copies font overrides (fresh objects) and drops blank faces', () => {
    const s = settings({
      fontOverrides: {
        'Inter::Semi Bold': { face: ' Inter SemiBold ', bold: false, italic: true },
        'Inter::Black': { face: '   ', bold: true, italic: false },
      },
    });
    const o = buildOptionsFromSettings(s, 'x');
    expect(o.fontOverrides).toEqual({ 'Inter::Semi Bold': { face: 'Inter SemiBold', bold: false, italic: true } });
    expect(o.fontOverrides['Inter::Semi Bold']).not.toBe(s.fontOverrides['Inter::Semi Bold']);
  });

  it('never returns the same object twice (pptxgenjs mutates options)', () => {
    const s = settings();
    const a = buildOptionsFromSettings(s, 't');
    const b = buildOptionsFromSettings(s, 't');
    expect(a).not.toBe(b);
    expect(a.fontOverrides).not.toBe(b.fontOverrides);
  });
});

describe('settingsForFormat', () => {
  it('image formats force image mode + JPEG (compression off counts as balanced there)', () => {
    for (const f of ['pptx-image', 'pdf-image'] as const) {
      const s = settingsForFormat(f, settings({ mode: 'editable', compression: 'off', jpeg: false }));
      expect(s.mode).toBe('image');
      expect(s.jpeg).toBe(true);
      expect(s.compression).toBe('balanced');
      expect(settingsForFormat(f, settings({ compression: 'strong' })).compression).toBe('strong');
    }
    expect(settingsForFormat('pptx', settings({ compression: 'off' }))).toMatchObject({ compression: 'off', jpeg: false });
  });

  it('the editable target and the IR dump use Editable / Exact look ("Image only" → Editable)', () => {
    expect(settingsForFormat('pptx', settings({ mode: 'image' })).mode).toBe('editable');
    expect(settingsForFormat('ir-json', settings({ mode: 'image' })).mode).toBe('editable');
    expect(settingsForFormat('pptx', settings({ mode: 'exact' })).mode).toBe('exact');
    expect(settingsForFormat('pdf', settings({ mode: 'exact' })).mode).toBe('exact');
    expect(editableMode('image')).toBe('editable');
    expect(editableMode('exact')).toBe('exact');
  });

  it('other formats keep the settings but return a copy', () => {
    const input = settings({ mode: 'exact', fontOverrides: { 'A::B': { face: 'X', bold: false, italic: false } } });
    const s = settingsForFormat('pptx', input);
    expect(s).toEqual(input);
    expect(s).not.toBe(input);
    expect(s.fontOverrides).not.toBe(input.fontOverrides);
  });
});

describe('file kinds', () => {
  it('extensions and MIME types', () => {
    expect(fileKindOf('pptx')).toEqual({ extension: '.pptx', mime: PPTX_MIME });
    expect(fileKindOf('pptx-image')).toEqual({ extension: '.pptx', mime: PPTX_MIME });
    expect(fileKindOf('pdf')).toEqual({ extension: '.pdf', mime: 'application/pdf' });
    expect(fileKindOf('pdf-image').extension).toBe('.pdf');
    expect(fileKindOf('ir-json')).toEqual({ extension: '.ir.json', mime: 'application/json' });
    expect(PPTX_MIME).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('only the vector PDF skips the IR', () => {
    expect(isIrFormat('pdf')).toBe(false);
    expect(isIrFormat('pdf-image')).toBe(true);
    expect(isIrFormat('pptx')).toBe(true);
  });
});

describe('font overrides', () => {
  const auto = autoFont('SB Sans Display', 'Semibold', 'ribbi');

  it('autoFont follows the naming rule, effectiveFont prefers overrides', () => {
    expect(auto).toEqual({ face: 'SB Sans Display Semibold', bold: false, italic: false, overridden: false });
    expect(autoFont('Inter', 'Bold', 'full').face).toBe('Inter Bold');
    for (const naming of ['ribbi', 'full'] as const) {
      for (const [family, style] of [['Inter', 'Bold'], ['SB Sans Text', 'Bold Italic'], ['Inter', 'Regular'], ['Inter', 'Semi Bold']]) {
        expect(autoFont(family, style, naming)).toEqual(resolveFont(family, style, undefined, naming));
      }
    }
    expect(autoFont('Inter', 'Bold', 'ribbi')).toMatchObject({ face: 'Inter', bold: true });
    expect(autoFont('Inter', 'Bold', 'full')).toMatchObject({ face: 'Inter Bold', bold: false });
    expect(effectiveFont('Inter', 'Bold', { fontNaming: 'full', fontOverrides: {} }).face).toBe('Inter Bold');
    const s = { fontNaming: 'ribbi' as const, fontOverrides: { [fontKey('Inter', 'Bold')]: { face: 'Inter Heavy', bold: false, italic: false } } };
    expect(effectiveFont('Inter', 'Bold', s)).toEqual({ face: 'Inter Heavy', bold: false, italic: false, overridden: true });
    expect(effectiveFont('Inter', 'Regular', s)).toEqual(resolveFont('Inter', 'Regular'));
  });

  it('adds, replaces and removes an override', () => {
    let o = applyFontOverride({}, 'SB Sans Display', 'Semibold', { face: 'SB Sans Display', bold: true, italic: false }, auto);
    expect(o).toEqual({ 'SB Sans Display::Semibold': { face: 'SB Sans Display', bold: true, italic: false } });
    o = applyFontOverride(o, 'SB Sans Display', 'Semibold', { face: '  SBSD Semi ', bold: false, italic: false }, auto);
    expect(o['SB Sans Display::Semibold']).toEqual({ face: 'SBSD Semi', bold: false, italic: false });
    o = applyFontOverride(o, 'SB Sans Display', 'Semibold', null, auto);
    expect(o).toEqual({});
  });

  it('drops overrides equal to the automatic mapping or with a blank face', () => {
    const other = { 'Inter::Bold': { face: 'X', bold: true, italic: false } };
    expect(applyFontOverride(other, 'SB Sans Display', 'Semibold', { face: 'SB Sans Display Semibold', bold: false, italic: false }, auto)).toEqual(other);
    expect(applyFontOverride(other, 'SB Sans Display', 'Semibold', { face: '   ', bold: true, italic: false }, auto)).toEqual(other);
  });

  it('does not mutate the input map', () => {
    const input = { 'Inter::Bold': { face: 'X', bold: true, italic: false } };
    const out = applyFontOverride(input, 'Inter', 'Bold', null, autoFont('Inter', 'Bold', 'ribbi'));
    expect(out).toEqual({});
    expect(input).toEqual({ 'Inter::Bold': { face: 'X', bold: true, italic: false } });
  });
});
