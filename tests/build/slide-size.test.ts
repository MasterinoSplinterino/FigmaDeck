/**
 * Regression test for PowerPoint's 56-inch limit (docs/reference-analysis.md §1): a 4992×1536 frame
 * exported 1 px = 1 pt is 69.3″ wide and PowerPoint refuses the file. The builder scales the deck.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import type { BuildOptions, BuildResult } from '../../src/build/api';
import type { Deck } from '../../src/ir/types';
import { deck, para, rgb, run, shape, slide, text, tf } from '../fixtures/ir-builders';
import { FIXTURE_NAMES, loadFixture, testOptions } from '../fixtures/load';
import { elements, objectByName, openPptx, slideCount, slideSize, slideXml, tagAttrs, validatePackage, type PptxPackage } from '../helpers/ooxml';

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

// ─── Fixed slide size (BuildOptions.slideSize) ───────────────────────────────

async function buildWith(d: Deck, o: Partial<BuildOptions>) {
  const res = await buildPptx(d, testOptions(o));
  const p = await openPptx(res.data);
  expect(validatePackage(p)).toEqual([]);
  return { result: res, pkg: p };
}

/** `<a:xfrm>` off / ext of an object's XML, EMU (pictures may have an `<a:ext uri>` before it). */
function xfrmOf(obj: string) {
  const m = /<a:xfrm\b[^>]*>\s*<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(obj);
  if (!m) throw new Error('xfrm not found');
  return { x: Number(m[1]), y: Number(m[2]), cx: Number(m[3]), cy: Number(m[4]) };
}

/** Off / ext of a named object, EMU. */
function box(xml: string, name: string) {
  return xfrmOf(objectByName(xml, name));
}

/** Agency template: 87.82 × 27.09 cm. */
const AGENCY = { widthIn: 34.575, heightIn: 10.665 };
/** 16 × 9 in = 1152 × 648 pt. */
const SIXTEEN_NINE = { widthIn: 16, heightIn: 9 };

describe('fixed slide size: agency template 34.575″ × 10.665″, 4992×1536 frame', () => {
  const W = AGENCY.widthIn * 72;
  const H = AGENCY.heightIn * 72;
  const s = Math.min(W / 4992, H / 1536);
  let res: BuildResult;
  let p: PptxPackage;

  beforeAll(async () => {
    ({ result: res, pkg: p } = await buildWith(loadFixture('startup-summit-wide'), { slideSize: AGENCY }));
  });

  it('presentation size is exactly the template size', () => {
    const { cx, cy } = slideSize(p);
    expect(Math.abs(cx - 31615020)).toBeLessThanOrEqual(1000);
    expect(Math.abs(cy - 9752076)).toBeLessThanOrEqual(1000);
  });

  it('the frame is scaled uniformly (min of both ratios) and centered', () => {
    const { cx, cy } = slideSize(p);
    const xml = slideXml(p, 1);
    const bg = box(xml, 'Background');
    // Width-limited: full width, equal margins top and bottom.
    expect(bg.x).toBe(0);
    expect(Math.abs(bg.cx - cx)).toBeLessThanOrEqual(1);
    expect(Math.abs(bg.cy - 1536 * s * 12700)).toBeLessThanOrEqual(1);
    expect(Math.abs(bg.y - ((H - 1536 * s) / 2) * 12700)).toBeLessThanOrEqual(1);
    expect(Math.abs(bg.y - (cy - bg.y - bg.cy))).toBeLessThanOrEqual(2);
    // Positions: card 1 background (inside stroke → inset by half the weight).
    const card = box(xml, 'Card 1');
    expect(Math.abs(card.x - (1345 + 3.2533 / 2) * s * 12700)).toBeLessThanOrEqual(2);
    expect(Math.abs(card.y - ((H - 1536 * s) / 2 + (380 + 3.2533 / 2) * s) * 12700)).toBeLessThanOrEqual(2);
  });

  it('font sizes, letter spacing, line spacing and effects are scaled by the same factor', () => {
    const xml = slideXml(p, 1);
    expect(tagAttrs(objectByName(xml, 'Sber500 в цифрах: 2018 - 2026 гг.'), 'a:rPr')[0].sz).toBe(String(Math.round(95.1126 * s * 100)));
    const number = objectByName(xml, '9 500');
    expect(tagAttrs(number, 'a:rPr')[0]).toMatchObject({ sz: String(Math.round(224.61 * s * 100)), spc: String(Math.round(-10 * s * 100)) });
    expect(number).toContain(`<a:spcPts val="${Math.round(224.61 * 1.1 * s * 100)}"/>`);
    const card = objectByName(xml, 'Card 1');
    expect(tagAttrs(card, 'a:innerShdw')[0].blurRad).toBe(String(Math.round(130.13 * s * 12700)));
    expect(tagAttrs(card, 'a:ln')[0].w).toBe(String(Math.round(3.2533 * s * 12700)));
  });

  it('reports the scaling as info', () => {
    const scaled = res.report.filter((r) => r.code === 'slide-scaled');
    expect(scaled).toHaveLength(1);
    expect(scaled[0]).toMatchObject({ level: 'info', slideName: 'Sber500 в цифрах' });
    expect(scaled[0].message).toContain('34.575×10.665 in');
    expect(scaled[0].message).toContain(`${(s * 100).toFixed(1)}%`);
  });
});

describe('fixed slide size: mixed aspect ratios', () => {
  it('every slide is fitted and centered (letterboxed), the slide background fills the margins', async () => {
    const { pkg: p, result: res } = await buildWith(loadFixture('mixed-sizes'), { slideSize: SIXTEEN_NINE });
    expect(slideSize(p)).toEqual({ cx: 16 * 914400, cy: 9 * 914400 });
    const pt = (v: number) => Math.round(v * 12700);
    // 1920×1080 → 0.6
    expect(box(slideXml(p, 1), 'Frame fill')).toEqual({ x: 0, y: 0, cx: pt(1152), cy: pt(648) });
    // 1080×1080 → 0.6, pillarboxed: (1152 − 648) / 2 = 252 pt on each side
    expect(box(slideXml(p, 2), 'Frame fill')).toEqual({ x: pt(252), y: 0, cx: pt(648), cy: pt(648) });
    // 3840×2160 → 0.3
    expect(box(slideXml(p, 3), 'Frame fill')).toEqual({ x: 0, y: 0, cx: pt(1152), cy: pt(648) });
    expect(tagAttrs(objectByName(slideXml(p, 3), 'Label'), 'a:rPr')[0].sz).toBe(String(Math.round(Math.round(2160 * 0.06) * 0.3 * 100)));
    for (let i = 1; i <= 3; i++) expect(slideXml(p, i)).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/>');
    expect(res.report.filter((r) => r.code === 'slide-scaled').map((r) => [r.slideName, r.level])).toEqual([
      ['Full HD', 'info'],
      ['Square', 'info'],
      ['4K', 'info'],
    ]);
  });

  it('a 3.25:1 frame in a 16:9 slide is letterboxed top and bottom', async () => {
    const { pkg: p } = await buildWith(loadFixture('startup-summit-wide'), { slideSize: SIXTEEN_NINE });
    const s = 1152 / 4992;
    const bg = box(slideXml(p, 1), 'Background');
    expect(bg.x).toBe(0);
    expect(Math.abs(bg.y - ((648 - 1536 * s) / 2) * 12700)).toBeLessThanOrEqual(1);
    expect(bg.y).toBeGreaterThan(100 * 12700);
    expect(Math.abs(bg.y - (9 * 914400 - bg.y - bg.cy))).toBeLessThanOrEqual(2);
    expect(slideXml(p, 1)).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/>');
  });

  it('a slide that matches the size exactly is neither scaled nor reported', async () => {
    const mk = (id: string, name: string, w: number, h: number) =>
      slide(id, name, w, h, [
        shape('Fill', 'rect', tf(0, 0, w, h), { fill: { type: 'solid', color: rgb('0EA5E9') } }),
        text('Label', tf(10, 10, 200, 40), [para([run('Hello', { fontSize: 32 })])]),
      ]);
    const d = deck('Exact', [mk('1:1', 'Exact', 1152, 648), mk('1:2', 'Full HD', 1920, 1080)]);
    const { pkg: p, result: res } = await buildWith(d, { slideSize: SIXTEEN_NINE });
    expect(box(slideXml(p, 1), 'Fill')).toEqual({ x: 0, y: 0, cx: 1152 * 12700, cy: 648 * 12700 });
    expect(tagAttrs(objectByName(slideXml(p, 1), 'Label'), 'a:rPr')[0].sz).toBe('3200');
    expect(tagAttrs(objectByName(slideXml(p, 2), 'Label'), 'a:rPr')[0].sz).toBe(String(Math.round(32 * 0.6 * 100)));
    expect(res.report.filter((r) => r.code === 'slide-scaled').map((r) => r.slideName)).toEqual(['Full HD']);
  });

  it('each side is clamped to 1″…56″', async () => {
    const { pkg: p } = await buildWith(loadFixture('kitchen-sink'), { slideSize: { widthIn: 80, heightIn: 0.25 } });
    expect(slideSize(p)).toEqual({ cx: 51206400, cy: 914400 });
    const small = await buildWith(loadFixture('kitchen-sink'), { slideSize: { widthIn: -3, heightIn: 57 } });
    expect(slideSize(small.pkg)).toEqual({ cx: 914400, cy: 51206400 });
  });

  it('a non-finite size falls back to the first slide\'s size', async () => {
    const { pkg: p } = await buildWith(loadFixture('kitchen-sink'), { slideSize: { widthIn: Number.NaN, heightIn: 10 } });
    expect(slideSize(p)).toEqual({ cx: 1920 * 12700, cy: 1080 * 12700 });
  });
});

describe.each(FIXTURE_NAMES)('%s with a fixed slide size', (name) => {
  it.each([
    ['agency template', AGENCY],
    ['16:9', SIXTEEN_NINE],
  ] as const)('%s: valid package, sldSz = the size, content inside the slide', async (_label, size) => {
    const d = loadFixture(name);
    const { pkg: p } = await buildWith(d, { slideSize: size });
    const { cx, cy } = slideSize(p);
    expect(Math.abs(cx - size.widthIn * 914400)).toBeLessThanOrEqual(1);
    expect(Math.abs(cy - size.heightIn * 914400)).toBeLessThanOrEqual(1);
    expect(slideCount(p)).toBe(d.slides.length);
    for (let i = 1; i <= d.slides.length; i++) {
      const xml = slideXml(p, i);
      for (const obj of [...elements(xml, 'p:sp'), ...elements(xml, 'p:pic')]) {
        // Rotated objects' boxes may stick out; everything in the fixtures that is not rotated fits.
        if (/<a:xfrm [^>]*rot=/.test(obj)) continue;
        const b = xfrmOf(obj);
        expect(b.x).toBeGreaterThanOrEqual(-1);
        expect(b.y).toBeGreaterThanOrEqual(-1);
        // Width slack of auto-width text may overhang slightly (3 % of the box).
        const slack = /txBox="1"/.test(obj) ? b.cx * 0.03 : 0;
        expect(b.x + b.cx).toBeLessThanOrEqual(cx + slack + 2);
        expect(b.y + b.cy).toBeLessThanOrEqual(cy + 2);
      }
    }
  });
});
