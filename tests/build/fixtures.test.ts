/**
 * IR fixtures → buildPptx → unzip → XML assertions (tests/fixtures/*.ir.json, see scripts/make-fixtures.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import type { BuildResult } from '../../src/build/api';
import { convertLinearGradient, gradientFillXml } from '../../src/build/gradient';
import { CONFIG } from '../../src/config';
import type { Deck, Element, LinearGradientFill, ShapeElement } from '../../src/ir/types';
import { FIXTURE_NAMES, loadFixture, testOptions } from '../fixtures/load';
import {
  countTags,
  elements,
  objectByName,
  openPptx,
  relationships,
  slideCount,
  slideSize,
  slideXml,
  tagAttrs,
  validatePackage,
  type PptxPackage,
} from '../helpers/ooxml';

interface Built {
  deck: Deck;
  result: BuildResult;
  pkg: PptxPackage;
}

const built = new Map<string, Built>();

beforeAll(async () => {
  for (const name of FIXTURE_NAMES) {
    const deck = loadFixture(name);
    const result = await buildPptx(deck, testOptions());
    built.set(name, { deck, result, pkg: await openPptx(result.data) });
  }
});

const get = (name: string): Built => {
  const b = built.get(name);
  if (!b) throw new Error(`fixture ${name} not built`);
  return b;
};

function findElement(elements: Element[], name: string): Element | undefined {
  for (const el of elements) {
    if (el.name === name) return el;
    if (el.type === 'group') {
      const found = findElement(el.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

describe.each(FIXTURE_NAMES)('%s: package', (name) => {
  it('is a valid package (well-formed XML, relationships, content types, ids, slide size, no PptxGenJS)', () => {
    expect(validatePackage(get(name).pkg)).toEqual([]);
  });

  it('has one slide per IR slide and matching stats', () => {
    const { deck, result, pkg } = get(name);
    expect(slideCount(pkg)).toBe(deck.slides.length);
    expect(result.stats.slides).toBe(deck.slides.length);
    let pics = 0;
    let sps = 0;
    let grps = 0;
    for (let i = 1; i <= deck.slides.length; i++) {
      const xml = slideXml(pkg, i);
      pics += countTags(xml, 'p:pic');
      sps += countTags(xml, 'p:sp');
      grps += countTags(xml, 'p:grpSp');
    }
    expect(pics).toBe(result.stats.images);
    expect(sps).toBe(result.stats.texts + result.stats.shapes);
    expect(grps).toBe(result.stats.groups);
  });

  it('text boxes have zero insets, no autofit and exactly one <a:pPr> first in every <a:p>', () => {
    const { deck, pkg } = get(name);
    for (let i = 1; i <= deck.slides.length; i++) {
      const xml = slideXml(pkg, i);
      for (const a of tagAttrs(xml, 'a:bodyPr')) expect(a).toMatchObject({ lIns: '0', tIns: '0', rIns: '0', bIns: '0' });
      expect(xml).not.toMatch(/normAutofit|spAutoFit/);
      for (const p of elements(xml, 'a:p')) {
        expect(countTags(p, 'a:pPr')).toBe(1);
        expect(p.startsWith('<a:p><a:pPr ')).toBe(true);
      }
    }
  });

  it('writes our metadata and a portrait notes page', () => {
    const { pkg } = get(name);
    expect(pkg.text('docProps/app.xml')).toContain(`<Application>${CONFIG.meta.application}</Application>`);
    expect(pkg.text('docProps/app.xml')).toContain('<PresentationFormat>Custom</PresentationFormat>');
    expect(pkg.text('docProps/core.xml')).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created>');
    expect(pkg.text('docProps/core.xml')).toContain('<dc:creator>FigmaDeck tests</dc:creator>');
    expect(tagAttrs(pkg.text('ppt/presentation.xml'), 'p:notesSz')[0]).toEqual({ cx: '6858000', cy: '9144000' });
  });

  it('every roundRect adj is within 0…50 000', () => {
    const { deck, pkg } = get(name);
    for (let i = 1; i <= deck.slides.length; i++) {
      for (const gd of tagAttrs(slideXml(pkg, i), 'a:gd')) {
        const v = Number(/val (-?\d+)/.exec(gd.fmla)?.[1]);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(50000);
      }
    }
  });
});

describe('diploma', () => {
  const xml = () => slideXml(get('diploma').pkg, 1);
  const rPr = (objectName: string) => tagAttrs(objectByName(xml(), objectName), 'a:rPr');
  const latin = (objectName: string) => tagAttrs(objectByName(xml(), objectName), 'a:latin').map((a) => a.typeface);

  it('slide size = frame size (1 px = 1 pt)', () => {
    expect(slideSize(get('diploma').pkg)).toEqual({ cx: 595 * 12700, cy: 842 * 12700 });
  });

  it('64 px title: sz 6400, spc −192 (−3 %), absolute line spacing, ru-RU, "SB Sans Display Semibold"', () => {
    const obj = objectByName(xml(), 'Взрывной рост');
    expect(rPr('Взрывной рост')[0]).toMatchObject({ lang: 'ru-RU', sz: '6400', spc: '-192' });
    expect(rPr('Взрывной рост')[0].b).toBeUndefined();
    expect(latin('Взрывной рост')).toContain('SB Sans Display Semibold');
    expect(obj).toContain('<a:lnSpc><a:spcPts val="6400"/></a:lnSpc>');
    expect(tagAttrs(obj, 'a:bodyPr')[0].wrap).toBe('none');
  });

  it('9 px description: spc −27, 12 pt line spacing, wraps', () => {
    const obj = objectByName(xml(), 'Описание');
    expect(rPr('Описание')[0]).toMatchObject({ sz: '900', spc: '-27', lang: 'ru-RU' });
    expect(obj).toContain('<a:spcPts val="1200"/>');
    expect(tagAttrs(obj, 'a:bodyPr')[0].wrap).toBe('square');
  });

  it('RIBBI: Bold → family + b="1", Italic → family + i="1", Light / Medium keep the full name', () => {
    expect(latin('Иван Петров')).toContain('SB Sans Display');
    expect(rPr('Иван Петров')[0].b).toBe('1');
    expect(rPr('Должность')[1]).toMatchObject({ i: '1' });
    expect(latin('2026')).toContain('SB Sans Display Light');
    expect(latin('Технологическая премия')).toContain('SB Sans Text Medium');
    const fonts = get('diploma').result.fonts;
    expect(fonts.find((f) => f.style === 'Semibold' && f.family === 'SB Sans Display')).toMatchObject({ face: 'SB Sans Display Semibold', bold: false, runs: 1 });
    expect(fonts.find((f) => f.style === 'Bold')).toMatchObject({ face: 'SB Sans Display', bold: true });
  });

  it('UPPER text stays as typed with cap="all"', () => {
    const obj = objectByName(xml(), 'Победитель');
    expect(rPr('Победитель')[0]).toMatchObject({ cap: 'all', spc: '120' });
    expect(obj).toContain('<a:t>Победитель</a:t>');
  });

  it('lang per run: Latin en-US, Cyrillic ru-RU', () => {
    expect(rPr('Tech Awards · Москва').map((a) => a.lang)).toEqual(['en-US', 'ru-RU']);
  });

  it('escapes text and aligns right', () => {
    expect(objectByName(xml(), 'Должность')).toContain('<a:t>ООО «Ромашка &amp; Партнёры»</a:t>');
    expect(tagAttrs(objectByName(xml(), '2026'), 'a:pPr')[0].algn).toBe('r');
  });

  it('pictures: background covers the slide, logo carries an SVG blip with its own part and content type', () => {
    const { pkg } = get('diploma');
    expect(countTags(xml(), 'p:pic')).toBe(2);
    expect(countTags(xml(), 'p:sp')).toBe(9);
    const bg = objectByName(xml(), 'Background');
    expect(tagAttrs(bg, 'a:off')[0]).toEqual({ x: '0', y: '0' });
    expect(tagAttrs(bg, 'a:ext')[0]).toEqual({ cx: String(595 * 12700), cy: String(842 * 12700) });
    const logo = objectByName(xml(), 'Logo');
    const svgBlip = tagAttrs(logo, 'asvg:svgBlip')[0];
    expect(svgBlip).toBeDefined();
    const rel = relationships(pkg, 'ppt/slides/slide1.xml').find((r) => r.id === svgBlip['r:embed']);
    expect(rel?.target).toMatch(/^\.\.\/media\/.+\.svg$/);
    const part = 'ppt/' + rel!.target.slice(3);
    expect(new TextDecoder().decode(pkg.bytes(part))).toContain('<svg');
    expect(pkg.text('[Content_Types].xml')).toContain('<Default Extension="svg" ContentType="image/svg+xml"/>');
    // The blip extension is the last child of <a:blip>.
    expect(logo).toMatch(/<asvg:svgBlip [^>]*\/><\/a:ext><\/a:extLst><\/a:blip>/);
  });

  it('title and alt text', () => {
    const { pkg } = get('diploma');
    expect(pkg.text('docProps/core.xml')).toContain('<dc:title>Диплом — Технологическая премия</dc:title>');
    expect(tagAttrs(objectByName(xml(), 'Logo'), 'p:cNvPr')[0].descr).toBe('Logo');
  });
});

describe('kitchen-sink', () => {
  const pkg = () => get('kitchen-sink').pkg;
  const xml = () => slideXml(pkg(), 1);
  const deck = () => get('kitchen-sink').deck;

  it('native objects: pictures vs shapes vs groups', () => {
    expect(countTags(xml(), 'p:pic')).toBe(3);
    expect(countTags(xml(), 'p:sp')).toBe(23);
    expect(countTags(xml(), 'p:grpSp')).toBe(3);
    expect(get('kitchen-sink').result.stats).toEqual({ slides: 1, texts: 11, shapes: 12, images: 3, groups: 3 });
  });

  it('nested groups: Card ⊃ Card content, identity child transform', () => {
    const card = /<p:grpSp><p:nvGrpSpPr><p:cNvPr id="\d+" name="Card"\/>[\s\S]*<\/p:grpSp>/.exec(xml())?.[0] ?? '';
    expect(card).toContain('name="Card content"');
    const grp = /<p:grpSpPr><a:xfrm><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/><a:chOff x="(\d+)" y="(\d+)"\/><a:chExt cx="(\d+)" cy="(\d+)"\/>/.exec(card);
    expect(grp).not.toBeNull();
    expect(grp!.slice(1, 5)).toEqual(grp!.slice(5, 9));
  });

  it('linear gradient: gradFill with the converted angle and stop positions', () => {
    const el = findElement(deck().slides[0].elements, 'Gradient') as ShapeElement;
    const expected = gradientFillXml(convertLinearGradient(el.fill as LinearGradientFill, el.transform.w, el.transform.h, 1));
    const obj = objectByName(xml(), 'Gradient');
    expect(obj).toContain(expected);
    const lin = tagAttrs(obj, 'a:lin')[0];
    expect(lin.scaled).toBe('0');
    expect(Number(lin.ang)).toBeCloseTo(49.1 * 60000, -4);
    const pos = tagAttrs(obj, 'a:gs').map((g) => Number(g.pos));
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(pos[0]).toBeGreaterThan(0);
  });

  it('line: custom dash, round cap, arrow heads', () => {
    const obj = objectByName(xml(), 'Arrow line');
    expect(obj).toContain('prst="line"');
    expect(obj).toContain('<a:ln w="50800" cap="rnd">');
    expect(obj).toContain('<a:custDash><a:ds d="300000" sp="200000"/></a:custDash>');
    expect(obj).toMatch(/<a:headEnd type="oval"\/><a:tailEnd type="triangle"\/><\/a:ln>/);
    expect(objectByName(xml(), 'Dashed frame')).toContain('<a:ds d="300000" sp="200000"/><a:ds d="100000" sp="200000"/>');
  });

  it('strokes: inside semi-transparent stroke → fill + stroke shapes; outside → grown geometry', () => {
    const both = elements(xml(), 'p:sp').filter((s) => s.includes('name="Round rect"'));
    expect(both).toHaveLength(2);
    expect(both[0]).toContain('<a:ln><a:noFill/></a:ln>');
    expect(tagAttrs(both[1], 'a:ext')[0]).toEqual({ cx: String(232 * 12700), cy: String(152 * 12700) });
    expect(both[1]).toMatch(/<a:noFill\/><a:ln w="101600">/);
    expect(tagAttrs(objectByName(xml(), 'Ellipse'), 'a:ext')[0]).toEqual({ cx: String(246 * 12700), cy: String(166 * 12700) });
  });

  it('opacity → alpha on fills and text colors', () => {
    expect(elements(xml(), 'p:sp').filter((s) => s.includes('name="Round rect"'))[0]).toContain('<a:alpha val="80000"/>');
    expect(objectByName(xml(), 'Faded')).toContain('<a:srgbClr val="111111"><a:alpha val="40000"/></a:srgbClr>');
  });

  it('image: crop → srcRect, 50 % opacity → alphaModFix, roundRect clip; ellipse clip', () => {
    const photo = objectByName(xml(), 'Photo');
    expect(tagAttrs(photo, 'a:srcRect')[0]).toEqual({ l: '10000', r: '30000', t: '20000', b: '10000' });
    expect(photo).toContain('<a:alphaModFix amt="50000"/>');
    expect(photo).toContain('<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 12500"/></a:avLst></a:prstGeom>');
    expect(tagAttrs(photo, 'a:ext')[0]).toEqual({ cx: String(240 * 12700), cy: String(160 * 12700) });
    expect(objectByName(xml(), 'Round photo')).toContain('prst="ellipse"');
  });

  it('identical media is stored once', () => {
    const media = pkg().parts.filter((p) => p.startsWith('ppt/media/') && p.endsWith('.png'));
    expect(media).toHaveLength(2); // photo + play icon fallback
  });

  it('hyperlinks: external URL, slide jump, element-level link; unknown node dropped', () => {
    const rels = relationships(pkg(), 'ppt/slides/slide1.xml');
    const links = objectByName(xml(), 'Links');
    const hl = tagAttrs(links, 'a:hlinkClick');
    expect(hl).toHaveLength(2);
    expect(rels.find((r) => r.id === hl[0]['r:id'])).toMatchObject({ target: 'https://www.figma.com/?a=1&b=2', external: true });
    expect(hl[1].action).toBe('ppaction://hlinksldjump');
    expect(rels.find((r) => r.id === hl[1]['r:id'])).toMatchObject({ target: 'slide1.xml', external: false });
    expect(pkg().text('ppt/slides/_rels/slide1.xml.rels')).toContain('Target="https://www.figma.com/?a=1&amp;b=2"');
    const button = tagAttrs(objectByName(xml(), 'Button background'), 'a:hlinkClick')[0];
    expect(rels.find((r) => r.id === button['r:id'])?.target).toBe('https://example.com/buy?x=1&y=2');
    expect(get('kitchen-sink').result.report.some((r) => r.code === 'link-dropped' && r.nodeName === 'Links')).toBe(true);
  });

  it('lists, soft break, empty paragraph', () => {
    const lists = objectByName(xml(), 'Lists');
    const pPr = tagAttrs(lists, 'a:pPr');
    const indent = Math.round(16 * CONFIG.text.listIndentEm * 12700);
    expect(pPr[0]).toMatchObject({ marL: String(indent), indent: String(-indent), lvl: '0' });
    expect(pPr[1]).toMatchObject({ marL: String(2 * indent), lvl: '1' });
    expect(lists).toContain(`<a:buChar char="${CONFIG.text.bulletChars[0]}"/>`);
    expect(lists).toContain(`<a:buChar char="${CONFIG.text.bulletChars[1]}"/>`);
    expect(countTags(lists, 'a:buAutoNum')).toBe(2);
    const paras = elements(lists, 'a:p');
    expect(paras).toHaveLength(6);
    expect(paras[4]).not.toContain('<a:r>');
    expect(paras[5]).toMatch(/<a:t>Line one<\/a:t><\/a:r><a:br><a:rPr [^>]*>.*<\/a:rPr><\/a:br><a:r>/);
  });

  it('text case, letter spacing, baseline, strike', () => {
    expect(tagAttrs(objectByName(xml(), 'Upper'), 'a:rPr')[0]).toMatchObject({ cap: 'all', spc: '150', b: '1' });
    expect(objectByName(xml(), 'Cases')).toContain('<a:t>Title Case Words, </a:t>');
    expect(tagAttrs(objectByName(xml(), 'Cases'), 'a:rPr')[2].cap).toBe('small');
    const formula = tagAttrs(objectByName(xml(), 'Formula'), 'a:rPr');
    expect(formula[1].baseline).toBe('30000');
    expect(formula[3].strike).toBe('sngStrike');
  });

  it('rotation, shadows', () => {
    expect(tagAttrs(objectByName(xml(), 'Rotated'), 'a:xfrm')[0].rot).toBe('900000');
    const card = objectByName(xml(), 'Card background');
    expect(tagAttrs(card, 'a:outerShdw')[0]).toMatchObject({ dist: '101600', dir: '5400000', blurRad: String(24 * 12700) });
    expect(card).toContain('<a:alpha val="15000"/>');
    expect(tagAttrs(objectByName(xml(), 'Inset'), 'a:innerShdw')[0]).toMatchObject({ dist: String(4 * 12700), dir: '5400000' });
  });

  it('wrap: auto-width → none, fixed multi-line → square; vertical anchor', () => {
    expect(tagAttrs(objectByName(xml(), 'Title'), 'a:bodyPr')[0]).toMatchObject({ wrap: 'none', anchor: 't' });
    expect(tagAttrs(objectByName(xml(), 'Justified'), 'a:bodyPr')[0]).toMatchObject({ wrap: 'square', anchor: 'ctr' });
    const j = tagAttrs(objectByName(xml(), 'Justified'), 'a:pPr');
    expect(j[0]).toMatchObject({ algn: 'just', indent: String(24 * 12700) });
    expect(objectByName(xml(), 'Justified')).toContain('<a:spcAft><a:spcPts val="1200"/></a:spcAft>');
  });

  it('speaker notes are escaped', () => {
    expect(pkg().text('ppt/notesSlides/notesSlide1.xml')).toContain('Speaker notes &amp; &lt;markup&gt; stay text.');
  });

  it('no empty lines: shapes without stroke get <a:ln><a:noFill/></a:ln>', () => {
    expect(objectByName(xml(), 'Gradient')).toContain('<a:ln><a:noFill/></a:ln>');
  });
});

describe('mixed-sizes', () => {
  it('one slide size; other sizes fitted, centered and reported', () => {
    const { pkg, result } = get('mixed-sizes');
    expect(slideSize(pkg)).toEqual({ cx: 1920 * 12700, cy: 1080 * 12700 });
    const square = objectByName(slideXml(pkg, 2), 'Frame fill');
    expect(tagAttrs(square, 'a:off')[0]).toEqual({ x: String(420 * 12700), y: '0' });
    expect(tagAttrs(square, 'a:ext')[0]).toEqual({ cx: String(1080 * 12700), cy: String(1080 * 12700) });
    const k4 = slideXml(pkg, 3);
    expect(tagAttrs(objectByName(k4, 'Frame fill'), 'a:ext')[0]).toEqual({ cx: String(1920 * 12700), cy: String(1080 * 12700) });
    expect(tagAttrs(objectByName(k4, 'Label'), 'a:rPr')[0].sz).toBe(String(Math.round(Math.round(2160 * 0.06) * 0.5 * 100)));
    const scaled = result.report.filter((r) => r.code === 'slide-scaled');
    expect(scaled.map((r) => [r.slideName, r.level])).toEqual([
      ['Square', 'warning'],
      ['4K', 'warning'],
    ]);
  });
});

describe('tiny', () => {
  it('48 px frame → 1″ slide, content scaled 1.5×', () => {
    const { pkg, result } = get('tiny');
    expect(slideSize(pkg)).toEqual({ cx: 914400, cy: 914400 });
    expect(tagAttrs(objectByName(slideXml(pkg, 1), 'Dot'), 'a:ext')[0]).toEqual({ cx: String(32 * 1.5 * 12700), cy: String(32 * 1.5 * 12700) });
    expect(tagAttrs(objectByName(slideXml(pkg, 1), 'Hi'), 'a:rPr')[0].sz).toBe(String(Math.round(11 * 1.5 * 100)));
    expect(result.report.find((r) => r.code === 'slide-scaled')?.level).toBe('info');
  });
});
