import { describe, expect, it } from 'vitest';
import { computeDeckLayout, deckScaleFor, fitInto } from '../../src/build/layout';

describe('deckScaleFor', () => {
  it('keeps 1 px = 1 pt inside 1″…56″', () => {
    expect(deckScaleFor(1920, 1080)).toBe(1);
    expect(deckScaleFor(4032, 100)).toBe(1);
    expect(deckScaleFor(72, 72)).toBe(1);
  });

  it('scales down frames longer than 4032 px (56″)', () => {
    expect(deckScaleFor(4992, 1536)).toBeCloseTo(4032 / 4992, 12);
    expect(deckScaleFor(1000, 8000)).toBeCloseTo(4032 / 8000, 12);
  });

  it('scales up frames shorter than 72 px (1″)', () => {
    expect(deckScaleFor(48, 48)).toBeCloseTo(1.5, 12);
    expect(deckScaleFor(300, 36)).toBeCloseTo(2, 12);
  });

  it('extreme aspect ratios: the 56″ limit wins', () => {
    expect(deckScaleFor(10000, 50)).toBeCloseTo(4032 / 10000, 12);
  });
});

describe('fitInto', () => {
  it('fits uniformly and centers', () => {
    expect(fitInto(1080, 1080, 1920, 1080)).toEqual({ scale: 1, offsetX: 420, offsetY: 0 });
    expect(fitInto(3840, 2160, 1920, 1080)).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0 });
    const f = fitInto(1000, 2000, 1920, 1080);
    expect(f.scale).toBeCloseTo(0.54, 12);
    expect(f.offsetX).toBeCloseTo((1920 - 540) / 2, 9);
  });
});

describe('computeDeckLayout', () => {
  it('first slide defines the size', () => {
    const l = computeDeckLayout([{ width: 1920, height: 1080 }]);
    expect(l).toMatchObject({ widthPt: 1920, heightPt: 1080, deckScale: 1 });
    expect(l.placements[0]).toEqual({ scale: 1, offsetX: 0, offsetY: 0, sizeDiffers: false });
  });

  it('5K wide frame → 56″ wide slide, everything scaled', () => {
    const l = computeDeckLayout([{ width: 4992, height: 1536 }]);
    expect(l.widthPt).toBeCloseTo(4032, 9);
    expect(l.heightPt).toBeCloseTo(1536 * (4032 / 4992), 9);
    expect(l.placements[0].scale).toBeCloseTo(4032 / 4992, 12);
    expect(Math.round(l.widthPt * 12700)).toBeLessThanOrEqual(51206400);
  });

  it('tiny frame → 1″ slide', () => {
    const l = computeDeckLayout([{ width: 48, height: 48 }]);
    expect(l.widthPt).toBeCloseTo(72, 9);
    expect(l.placements[0].scale).toBeCloseTo(1.5, 12);
  });

  it('extreme aspect ratio pads the short side to 1″ and centers the content', () => {
    const l = computeDeckLayout([{ width: 10000, height: 50 }]);
    expect(l.widthPt).toBeCloseTo(4032, 9);
    expect(l.heightPt).toBe(72);
    const p = l.placements[0];
    expect(p.offsetY).toBeCloseTo((72 - 50 * p.scale) / 2, 9);
  });

  it('other slides are fitted into the first size and centered', () => {
    const l = computeDeckLayout([
      { width: 1920, height: 1080 },
      { width: 1080, height: 1080 },
      { width: 3840, height: 2160 },
      { width: 1920, height: 1080 },
    ]);
    expect(l.placements[1]).toEqual({ scale: 1, offsetX: 420, offsetY: 0, sizeDiffers: true });
    expect(l.placements[2]).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0, sizeDiffers: true });
    expect(l.placements[3]).toEqual({ scale: 1, offsetX: 0, offsetY: 0, sizeDiffers: false });
  });

  it('deck scale applies to same-size slides and fits others into the scaled size', () => {
    const l = computeDeckLayout([
      { width: 4992, height: 1536 },
      { width: 4992, height: 1536 },
      { width: 1920, height: 1080 },
    ]);
    const s = 4032 / 4992;
    expect(l.placements[1].scale).toBeCloseTo(s, 12);
    expect(l.placements[2].scale).toBeCloseTo((1536 * s) / 1080, 12);
  });

  it('rejects empty decks and invalid sizes', () => {
    expect(() => computeDeckLayout([])).toThrow(/no slides/);
    expect(() => computeDeckLayout([{ width: 0, height: 100 }])).toThrow(/invalid size/);
    expect(() => computeDeckLayout([{ width: 100, height: Number.NaN }])).toThrow(/invalid size/);
  });
});
