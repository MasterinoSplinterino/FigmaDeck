import { beforeAll, describe, expect, it } from 'vitest';
import { buildOptionsFromSettings } from '../../src/ui/options';
import { CONFIG } from '../../src/config';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/shared/settings';
import { setLang } from '../../src/ui/i18n';
import {
  CM_PER_INCH,
  SLIDE_PRESETS,
  clampSlideInches,
  defaultUnit,
  formatLength,
  fromUnit,
  matchPreset,
  ratioText,
  roundToUnit,
  summarizeSlideSize,
  toUnit,
} from '../../src/ui/slide-size';

beforeAll(() => setLang('en'));

const EMU_PER_IN = CONFIG.units.emuPerInch;
const LED = { width: 4992, height: 1536 };
const custom = (widthIn: number, heightIn: number) => ({ slideSizeMode: 'custom' as const, slideWidthIn: widthIn, slideHeightIn: heightIn });
const frameMode = { slideSizeMode: 'frame' as const, slideWidthIn: 13.333, slideHeightIn: 7.5 };
const preset = (id: string) => SLIDE_PRESETS.find((p) => p.id === id)!;

describe('units', () => {
  it('cm ⇄ in, rounded to 0.01 cm / 0.001 in', () => {
    expect(toUnit(1, 'cm')).toBe(2.54);
    expect(fromUnit(2.54, 'cm')).toBe(1);
    expect(toUnit(3, 'in')).toBe(3);
    expect(roundToUnit(87.82 / CM_PER_INCH, 'cm')).toBe(87.82);
    expect(roundToUnit(87.82 / CM_PER_INCH, 'in')).toBe(34.575);
    expect(formatLength(27.09 / CM_PER_INCH, 'cm', 'ru')).toBe('27,09');
    expect(formatLength(7.5, 'in', 'en')).toBe('7.5');
  });

  it('default unit: cm for Russian, inches otherwise', () => {
    expect(defaultUnit('ru')).toBe('cm');
    expect(defaultUnit('en')).toBe('in');
  });

  it('clamps to PowerPoint’s 1–56 in', () => {
    expect(clampSlideInches(0.2)).toBe(CONFIG.slide.minInches);
    expect(clampSlideInches(80)).toBe(CONFIG.slide.maxInches);
    expect(clampSlideInches(34.5)).toBe(34.5);
  });
});

describe('presets', () => {
  it('sizes: 16:9, 4:3, LED wide, agency template', () => {
    expect(preset('widescreen').widthIn * EMU_PER_IN).toBeCloseTo(12192000, 3);
    expect(preset('widescreen').heightIn).toBe(7.5);
    expect([preset('standard').widthIn, preset('standard').heightIn]).toEqual([10, 7.5]);
    expect([preset('led').widthIn, preset('led').heightIn]).toEqual([56, 17.23]);
    // 87.82 × 27.09 cm = 34.575″ × 10.665″, exactly 31 615 200 × 9 752 400 EMU.
    expect(Math.round(preset('agency').widthIn * EMU_PER_IN)).toBe(31615200);
    expect(Math.round(preset('agency').heightIn * EMU_PER_IN)).toBe(9752400);
    for (const p of SLIDE_PRESETS) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, ...custom(p.widthIn, p.heightIn) }).slideWidthIn).toBe(p.widthIn);
    }
  });

  it('matchPreset accepts typed-in rounded values', () => {
    expect(matchPreset(13.333, 7.5)?.id).toBe('widescreen'); // DEFAULT_SETTINGS
    expect(matchPreset(DEFAULT_SETTINGS.slideWidthIn, DEFAULT_SETTINGS.slideHeightIn)?.id).toBe('widescreen');
    expect(matchPreset(34.575, 10.665)?.id).toBe('agency');
    expect(matchPreset(fromUnit(87.82, 'cm'), fromUnit(27.09, 'cm'))?.id).toBe('agency');
    expect(matchPreset(56, 17.23)?.id).toBe('led');
    expect(matchPreset(20, 10)).toBeNull();
  });

  it('the agency preset reaches the builder options in inches', () => {
    const p = preset('agency');
    const o = buildOptionsFromSettings(normalizeSettings({ ...DEFAULT_SETTINGS, ...custom(p.widthIn, p.heightIn) }), 't');
    expect(o.slideSize?.widthIn).toBeCloseTo(34.5748, 4);
    expect(o.slideSize?.heightIn).toBeCloseTo(10.6654, 4);
  });
});

describe('ratioText', () => {
  it('names the usual ratios, otherwise "N:1"', () => {
    expect(ratioText(1920 / 1080)).toBe('16:9');
    expect(ratioText(13.333 / 7.5)).toBe('16:9');
    expect(ratioText(4 / 3)).toBe('4:3');
    expect(ratioText(1080 / 1440)).toBe('3:4');
    expect(ratioText(4992 / 1536)).toBe('3.25:1');
    expect(ratioText(87.82 / 27.09)).toBe('3.24:1');
    expect(ratioText(87.82 / 27.09, 'ru')).toBe('3,24:1');
  });
});

describe('summarizeSlideSize', () => {
  it('no frames → null', () => {
    expect(summarizeSlideSize([], frameMode)).toBeNull();
  });

  it('frame mode: 4992×1536 is scaled into 56″ (the builder’s layout)', () => {
    const s = summarizeSlideSize([LED, LED], frameMode)!;
    expect(s.widthIn).toBeCloseTo(56, 9);
    expect(s.heightIn).toBeCloseTo(17.2308, 4);
    expect(s.scale).toBeCloseTo(4032 / 4992, 9);
    expect(s.mismatched).toBe(0);
    expect(s.letterbox).toBeNull();
    expect(s.otherSizes).toBe(0);
  });

  it('frame mode: 1920×1080 stays 1 px = 1 pt; other sizes are counted', () => {
    const s = summarizeSlideSize([{ width: 1920, height: 1080 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }], frameMode)!;
    expect([s.widthIn, s.heightIn, s.scale]).toEqual([1920 / 72, 15, 1]);
    expect(s.otherSizes).toBe(1);
    expect(s.mismatched).toBe(1);
    expect(s.letterbox).toBeNull(); // mixed sizes → "N of M frames" message instead
  });

  it('LED preset: 4992×1536 frames fill the slide', () => {
    const s = summarizeSlideSize([LED], custom(56, 17.23))!;
    expect(s.mismatched).toBe(0);
    expect(s.letterbox).toBeNull();
  });

  it('agency template: 3.25:1 frames on a 3.24:1 slide get thin bars at the top and bottom', () => {
    const p = preset('agency');
    const s = summarizeSlideSize([LED, LED], custom(p.widthIn, p.heightIn))!;
    expect(s.widthIn).toBeCloseTo(34.5748, 4);
    expect(s.ratio).toBeCloseTo(3.2418, 4);
    expect(s.mismatched).toBe(2);
    expect(s.letterbox?.axis).toBe('y');
    const expectedBar = (p.heightIn - 1536 * (p.widthIn / 4992)) / 2;
    expect(s.letterbox?.barIn).toBeCloseTo(expectedBar, 9);
    expect(toUnit(s.letterbox!.barIn, 'cm')).toBeCloseTo(0.034, 3);
    expect(s.scale).toBeCloseTo((p.widthIn * 72) / 4992, 9);
  });

  it('16:9 slide with LED frames: wide bars at the top and bottom; portrait frame: left and right', () => {
    const wide = summarizeSlideSize([LED], custom(40 / 3, 7.5))!;
    expect(wide.letterbox?.axis).toBe('y');
    expect(wide.letterbox?.barIn).toBeGreaterThan(1.5);
    const portrait = summarizeSlideSize([{ width: 1080, height: 1440 }], custom(40 / 3, 7.5))!;
    expect(portrait.letterbox?.axis).toBe('x');
  });
});
