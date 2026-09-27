import { describe, expect, it } from 'vitest';
import { FontTracker } from '../../src/build/fonts';
import { parseStyle, resolveFont, ribbiFont } from '../../src/fonts/mapping';

describe('parseStyle', () => {
  it.each([
    ['Regular', '', false],
    ['Italic', '', true],
    ['Bold Italic', 'Bold', true],
    ['Bold-Italic', 'Bold', true],
    ['BoldItalic', 'Bold', true],
    ['Semibold Italic', 'Semibold', true],
    ['SemiboldIt', 'Semibold', true],
    ['Light Oblique', 'Light', true],
    ['It', '', true],
    ['Italic Bold', 'Bold', true],
    ['Medium', 'Medium', false],
  ])('%s → "%s" italic=%s', (style, weightPart, italic) => {
    const p = parseStyle(style);
    expect(p.italic).toBe(italic);
    // "Regular" keeps its spelling; the RIBBI step treats it as regular.
    if (style !== 'Regular') expect(p.weightPart).toBe(weightPart);
  });
});

describe('RIBBI mapping', () => {
  it.each([
    // family, style → face, bold, italic
    ['Inter', 'Regular', 'Inter', false, false],
    ['Inter', 'Bold', 'Inter', true, false],
    ['Inter', 'Italic', 'Inter', false, true],
    ['Inter', 'Bold Italic', 'Inter', true, true],
    ['Inter', '', 'Inter', false, false],
    ['Inter', 'Normal', 'Inter', false, false],
    ['SB Sans Display', 'Semibold', 'SB Sans Display Semibold', false, false],
    ['SB Sans Display', 'Semibold Italic', 'SB Sans Display Semibold', false, true],
    ['SB Sans Display', 'Bold', 'SB Sans Display', true, false],
    ['SB Sans Text', 'Regular', 'SB Sans Text', false, false],
    ['SB Sans Text', 'Medium', 'SB Sans Text Medium', false, false],
    ['Inter', 'Semi Bold', 'Inter Semi Bold', false, false],
    ['Inter', 'Extra Bold', 'Inter Extra Bold', false, false],
    ['Inter', 'Light', 'Inter Light', false, false],
    ['Inter', 'Black Italic', 'Inter Black', false, true],
    ['Roboto', 'Condensed Bold', 'Roboto Condensed', true, false],
    ['Roboto', 'Condensed Regular', 'Roboto Condensed', false, false],
    ['Roboto', 'Condensed Bold Italic', 'Roboto Condensed', true, true],
    ['Futura PT', 'Book', 'Futura PT Book', false, false],
  ])('%s / %s → "%s" b=%s i=%s', (family, style, face, bold, italic) => {
    expect(ribbiFont(family, style)).toEqual({ face, bold, italic });
  });

  it('trims the family name', () => {
    expect(ribbiFont('  Inter ', 'Bold').face).toBe('Inter');
  });
});

describe('resolveFont overrides', () => {
  const overrides = {
    'SB Sans Display::Semibold': { face: 'SB Sans Display SemiBold', bold: false, italic: false },
    'Inter::Bold': { face: '   ', bold: true, italic: false },
  };

  it('uses an override by `${family}::${style}` key', () => {
    expect(resolveFont('SB Sans Display', 'Semibold', overrides)).toEqual({
      face: 'SB Sans Display SemiBold',
      bold: false,
      italic: false,
      overridden: true,
    });
  });

  it('ignores blank override faces and falls back to RIBBI', () => {
    expect(resolveFont('Inter', 'Bold', overrides)).toEqual({ face: 'Inter', bold: true, italic: false, overridden: false });
  });

  it('works without overrides', () => {
    expect(resolveFont('Inter', 'Medium Italic')).toEqual({ face: 'Inter Medium', bold: false, italic: true, overridden: false });
  });
});

describe('full-name mapping (fontNaming: full)', () => {
  it.each([
    ['SB Sans Display', 'Regular', 'SB Sans Display', false, false],
    ['SB Sans Display', 'Bold', 'SB Sans Display Bold', false, false],
    ['SB Sans Display', 'Bold Italic', 'SB Sans Display Bold', false, true],
    ['SB Sans Display', 'Italic', 'SB Sans Display', false, true],
    ['SB Sans Display', 'Semibold', 'SB Sans Display Semibold', false, false],
    ['Roboto', 'Condensed Bold', 'Roboto Condensed Bold', false, false],
  ])('%s / %s → "%s" b=%s i=%s', (family, style, face, bold, italic) => {
    expect(resolveFont(family, style, undefined, 'full')).toEqual({ face, bold, italic, overridden: false });
  });

  it('overrides win over both rules', () => {
    const o = { 'SB Sans Display::Bold': { face: 'SB Sans Display Heavy', bold: true, italic: false } };
    for (const naming of ['ribbi', 'full'] as const) {
      expect(resolveFont('SB Sans Display', 'Bold', o, naming)).toEqual({ face: 'SB Sans Display Heavy', bold: true, italic: false, overridden: true });
    }
  });
});

describe('FontTracker', () => {
  it('resolves with the naming rule and reports what was written', () => {
    const full = new FontTracker({}, 'full');
    full.use('SB Sans Display', 'Bold', 2);
    full.use('SB Sans Display', 'Bold');
    expect(full.report()).toEqual([
      { family: 'SB Sans Display', style: 'Bold', face: 'SB Sans Display Bold', bold: false, italic: false, overridden: false, runs: 3 },
    ]);
    const ribbi = new FontTracker({});
    expect(ribbi.use('SB Sans Display', 'Bold')).toEqual({ face: 'SB Sans Display', bold: true, italic: false, overridden: false });
  });

  it('treats unknown naming values as ribbi and lets overrides win', () => {
    const t = new FontTracker({ 'Inter::Bold': { face: 'Inter Heavy', bold: false, italic: false } }, 'other' as unknown as 'full');
    expect(t.resolve('Inter', 'Semi Bold').face).toBe('Inter Semi Bold');
    expect(t.resolve('Inter', 'Bold Italic')).toEqual({ face: 'Inter', bold: true, italic: true, overridden: false });
    expect(t.resolve('Inter', 'Bold')).toEqual({ face: 'Inter Heavy', bold: false, italic: false, overridden: true });
  });
});
