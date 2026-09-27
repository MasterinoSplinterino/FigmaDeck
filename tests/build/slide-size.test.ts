/**
 * Regression test for PowerPoint's 56-inch limit (docs/reference-analysis.md §1): a 4992×1536 frame
 * exported 1 px = 1 pt is 69.3″ wide and PowerPoint refuses the file. The builder scales the deck.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import type { BuildResult } from '../../src/build/api';
import { loadFixture, testOptions } from '../fixtures/load';
import { elements, objectByName, openPptx, slideSize, slideXml, tagAttrs, validatePackage, type PptxPackage } from '../helpers/ooxml';

const MAX_EMU = 51206400;
const SCALE = 4032 / 4992;

let result: BuildResult;
let pkg: PptxPackage;

beforeAll(async () => {
  result = await buildPptx(loadFixture('wide-5k'), testOptions());
  pkg = await openPptx(result.data);
});

describe('wide 5K frame (4992×1536 px)', () => {
  it('slide size is within PowerPoint limits: 56″ wide, aspect ratio kept', () => {
    const { cx, cy } = slideSize(pkg);
    expect(cx).toBeLessThanOrEqual(MAX_EMU);
    expect(cx).toBe(MAX_EMU);
    expect(cy).toBe(Math.round(1536 * SCALE * 12700));
    expect(validatePackage(pkg)).toEqual([]);
  });

  it('all content stays within the slide', () => {
    const { cx, cy } = slideSize(pkg);
    const xml = slideXml(pkg, 1);
    for (const obj of [...elements(xml, 'p:sp'), ...elements(xml, 'p:pic')]) {
      const off = tagAttrs(obj, 'a:off')[0];
      const ext = tagAttrs(obj, 'a:ext')[0];
      const x = Number(off.x);
      const y = Number(off.y);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      // Width slack of auto-width text may overhang by a few percent; everything else fits exactly.
      expect(x + Number(ext.cx)).toBeLessThanOrEqual(cx + 1);
      expect(y + Number(ext.cy)).toBeLessThanOrEqual(cy + 1);
    }
    const band = objectByName(xml, 'Band');
    expect(tagAttrs(band, 'a:ext')[0].cx).toBe(String(cx));
  });

  it('font sizes, line spacing and positions are scaled by the same factor', () => {
    const xml = slideXml(pkg, 1);
    const headline = objectByName(xml, 'Headline');
    expect(tagAttrs(headline, 'a:rPr')[0].sz).toBe(String(Math.round(64 * SCALE * 100)));
    expect(headline).toContain(`<a:spcPts val="${Math.round(80 * SCALE * 100)}"/>`);
    expect(tagAttrs(headline, 'a:off')[0]).toEqual({ x: String(Math.round(200 * SCALE * 12700)), y: String(Math.round(200 * SCALE * 12700)) });
    const photo = objectByName(xml, 'Photo');
    expect(tagAttrs(photo, 'a:ext')[0]).toEqual({
      cx: String(Math.round(4800 * SCALE * 12700) - Math.round(4000 * SCALE * 12700)),
      cy: String(Math.round(800 * SCALE * 12700) - Math.round(200 * SCALE * 12700)),
    });
    expect(photo).not.toContain('a:srcRect');
  });

  it('reports the scaling as info', () => {
    const entry = result.report.find((r) => r.code === 'slide-scaled');
    expect(entry).toMatchObject({ level: 'info', slideName: 'Wide 5K' });
    expect(entry?.message).toContain('80.8%');
  });
});
