/**
 * buildPptx behaviour with programmatic IR: options, metadata, links, groups, edge cases.
 */
import { describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import type { BuildOptions, BuildProgress } from '../../src/build/api';
import { CONFIG } from '../../src/config';
import type { Asset, Deck, Element } from '../../src/ir/types';
import { deck, group, image, para, pngAsset, rgb, run, shape, slide, svgAsset, text, tf } from '../fixtures/ir-builders';
import { loadFixture, testOptions } from '../fixtures/load';
import {
  countTags,
  elements,
  objectByName,
  objectNames,
  openPptx,
  relationships,
  slideXml,
  tagAttrs,
  validatePackage,
} from '../helpers/ooxml';

async function build(d: Deck, o: Partial<BuildOptions> = {}) {
  const result = await buildPptx(d, testOptions(o));
  const pkg = await openPptx(result.data);
  expect(validatePackage(pkg)).toEqual([]);
  return { result, pkg };
}

const red = (id = 'png-red'): Asset => pngAsset(id, 'raster', 4, 4, () => [255, 0, 0, 255], false);
const one = (elements: Element[], assets: Asset[] = [], o: Partial<Deck['meta']> = {}): Deck => {
  const d = deck('One', [slide('1:1', 'Frame', 1920, 1080, elements)], assets);
  d.meta = { ...d.meta, ...o };
  return d;
};

describe('options', () => {
  it('preserveGroups: false flattens groups (same objects, no grpSp)', async () => {
    const d = loadFixture('kitchen-sink');
    const flat = await build(d, { preserveGroups: false });
    const xml = slideXml(flat.pkg, 1);
    expect(countTags(xml, 'p:grpSp')).toBe(0);
    expect(flat.result.stats.groups).toBe(0);
    expect(countTags(xml, 'p:sp')).toBe(23);
  });

  it('svgVectors: false writes only the raster fallback', async () => {
    const { pkg } = await build(loadFixture('diploma'), { svgVectors: false });
    expect(slideXml(pkg, 1)).not.toContain('svgBlip');
    expect(pkg.parts.some((p) => p.endsWith('.svg'))).toBe(false);
  });

  it('textCase: transform uppercases the string instead of cap="all"', async () => {
    const { pkg } = await build(loadFixture('diploma'), { textCase: 'transform' });
    const obj = objectByName(slideXml(pkg, 1), 'Победитель');
    expect(obj).toContain('<a:t>ПОБЕДИТЕЛЬ</a:t>');
    expect(obj).not.toContain('cap=');
  });

  it('fontOverrides replace the RIBBI face and are reported', async () => {
    const { pkg, result } = await build(loadFixture('diploma'), {
      fontOverrides: { 'SB Sans Display::Semibold': { face: 'SBSans Display SemiBold', bold: false, italic: true } },
    });
    const obj = objectByName(slideXml(pkg, 1), 'Взрывной рост');
    expect(tagAttrs(obj, 'a:latin')[0].typeface).toBe('SBSans Display SemiBold');
    expect(tagAttrs(obj, 'a:rPr')[0].i).toBe('1');
    expect(result.fonts.find((f) => f.style === 'Semibold' && f.family === 'SB Sans Display')).toMatchObject({ overridden: true, italic: true });
  });

  it('widthSlackPercent widens auto-width text boxes', async () => {
    const el = text('T', tf(100, 100, 200, 20), [para([run('abc')])]);
    const a = await build(one([el]), { widthSlackPercent: 0 });
    const b = await build(one([el]), { widthSlackPercent: 10 });
    expect(tagAttrs(objectByName(slideXml(a.pkg, 1), 'T'), 'a:ext')[0].cx).toBe(String(200 * 12700));
    expect(tagAttrs(objectByName(slideXml(b.pkg, 1), 'T'), 'a:ext')[0].cx).toBe(String(220 * 12700));
  });
});

describe('metadata', () => {
  it('options win over deck.meta; never PptxGenJS', async () => {
    const { pkg } = await build(one([], [], { company: 'Deck Co', subject: 'S' }), { title: 'T & <x>', author: 'A', company: 'C' });
    const core = pkg.text('docProps/core.xml');
    expect(core).toContain('<dc:title>T &amp; &lt;x&gt;</dc:title>');
    expect(core).toContain('<dc:creator>A</dc:creator>');
    expect(core).toContain('<cp:lastModifiedBy>A</cp:lastModifiedBy>');
    expect(core).toContain('<dc:subject>S</dc:subject>');
    expect(pkg.text('docProps/app.xml')).toContain('<Company>C</Company>');
  });

  it('falls back to deck.meta, then CONFIG.meta', async () => {
    const d = one([]);
    d.meta = { title: '' };
    const { pkg } = await build(d);
    const core = pkg.text('docProps/core.xml');
    expect(core).toContain('<dc:title>Frame</dc:title>'); // first slide name
    expect(core).toContain(`<dc:creator>${CONFIG.meta.defaultAuthor}</dc:creator>`);
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:modified>');
  });
});

describe('progress', () => {
  it('reports slides, package and post phases', async () => {
    const events: BuildProgress[] = [];
    await buildPptx(loadFixture('mixed-sizes'), testOptions(), (p) => events.push({ ...p }));
    expect(events.filter((e) => e.phase === 'slides').map((e) => e.done)).toEqual([1, 2, 3]);
    expect(events.some((e) => e.phase === 'package' && e.done === 1)).toBe(true);
    expect(events.filter((e) => e.phase === 'post').at(-1)).toEqual({ phase: 'post', done: 3, total: 3 });
  });
});

describe('hyperlinks', () => {
  it('node links to another exported slide become slide jumps', async () => {
    const d = deck('Links', [
      slide('1:1', 'First', 800, 600, [text('Go', tf(10, 10, 100, 20), [para([run('next', { hyperlink: { type: 'node', nodeId: '2:2' } })])])]),
      slide('2:2', 'Second', 800, 600, [shape('Back', 'rect', tf(0, 0, 50, 50), { fill: { type: 'solid', color: rgb('000000') }, hyperlink: { type: 'node', nodeId: '1:1' } })]),
    ]);
    const { pkg } = await build(d);
    const go = tagAttrs(objectByName(slideXml(pkg, 1), 'Go'), 'a:hlinkClick')[0];
    expect(go.action).toBe('ppaction://hlinksldjump');
    expect(relationships(pkg, 'ppt/slides/slide1.xml').find((r) => r.id === go['r:id'])?.target).toBe('slide2.xml');
    const back = tagAttrs(objectByName(slideXml(pkg, 2), 'Back'), 'a:hlinkClick')[0];
    expect(relationships(pkg, 'ppt/slides/slide2.xml').find((r) => r.id === back['r:id'])?.target).toBe('slide1.xml');
  });

  it('the same URL used twice gets one relationship', async () => {
    const url = { type: 'url' as const, url: 'https://a.b/c' };
    const { pkg } = await build(one([text('T', tf(0, 0, 100, 20), [para([run('a', { hyperlink: url }), run('b'), run('c', { hyperlink: url })])])]));
    expect(relationships(pkg, 'ppt/slides/slide1.xml').filter((r) => r.type.endsWith('/hyperlink'))).toHaveLength(1);
  });

  it('group hyperlink: on the grpSp when preserved, on the members when flattened', async () => {
    const g = group('Card', [
      shape('A', 'rect', tf(0, 0, 10, 10), { fill: { type: 'solid', color: rgb('FF0000') } }),
      shape('B', 'rect', tf(20, 0, 10, 10), { fill: { type: 'solid', color: rgb('00FF00') } }),
    ]);
    g.hyperlink = { type: 'url', url: 'https://g.example' };
    const kept = await build(one([g]));
    expect(slideXml(kept.pkg, 1)).toMatch(/<p:cNvPr id="\d+" name="Card"><a:hlinkClick r:id="rId\d+"\/><\/p:cNvPr>/);
    const flat = await build(one([g]), { preserveGroups: false });
    expect(countTags(objectByName(slideXml(flat.pkg, 1), 'A'), 'a:hlinkClick')).toBe(1);
    expect(countTags(objectByName(slideXml(flat.pkg, 1), 'B'), 'a:hlinkClick')).toBe(1);
  });
});

describe('groups', () => {
  it('a group with one emitted child is not wrapped', async () => {
    const g = group('Solo', [shape('Only', 'rect', tf(0, 0, 10, 10), { fill: { type: 'solid', color: rgb('FF0000') } })]);
    const { pkg, result } = await build(one([g]));
    expect(countTags(slideXml(pkg, 1), 'p:grpSp')).toBe(0);
    expect(result.stats.groups).toBe(0);
  });

  it('group bounds = union of the members, identity child transform, unique ids', async () => {
    const inner = group('Inner', [
      shape('A', 'rect', tf(100, 100, 50, 50), { fill: { type: 'solid', color: rgb('FF0000') } }),
      shape('B', 'rect', tf(200, 150, 50, 50, 45), { fill: { type: 'solid', color: rgb('00FF00') } }),
    ]);
    const outer = group('Outer', [inner, text('C', tf(0, 400, 100, 20), [para([run('c')])])]);
    const { pkg } = await build(one([outer]));
    const xml = slideXml(pkg, 1);
    expect(countTags(xml, 'p:grpSp')).toBe(2);
    const ids = tagAttrs(xml, 'p:cNvPr').map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const innerXfrm = /name="Inner"\/>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    const half = (50 * Math.SQRT2) / 2;
    expect(Number(innerXfrm[1])).toBe(100 * 12700);
    expect(Number(innerXfrm[2])).toBe(100 * 12700);
    expect(Number(innerXfrm[3])).toBeCloseTo((225 + half - 100) * 12700, -1);
    expect(Number(innerXfrm[4])).toBeCloseTo((175 + half - 100) * 12700, -1);
  });
});

describe('geometry encoding', () => {
  it('objects far outside the slide keep exact EMU positions (pptxgenjs reads numbers >= 100 as EMU)', async () => {
    const { pkg } = await build(one([shape('Far', 'rect', tf(10000, -3000, 200, 100), { fill: { type: 'solid', color: rgb('FF0000') } })]));
    const obj = objectByName(slideXml(pkg, 1), 'Far');
    expect(tagAttrs(obj, 'a:off')[0]).toEqual({ x: String(10000 * 12700), y: String(-3000 * 12700) });
    expect(tagAttrs(obj, 'a:ext')[0]).toEqual({ cx: String(200 * 12700), cy: String(100 * 12700) });
  });

  it('heavily cropped pictures (full size > 100″) get the right srcRect and size', async () => {
    const img = image('Crop', 'png-red', tf(100, 100, 800, 600), { crop: { left: 0.9, top: 0.05, right: 0.02, bottom: 0.9 } });
    const { pkg } = await build(one([img], [red()]));
    const obj = objectByName(slideXml(pkg, 1), 'Crop');
    expect(tagAttrs(obj, 'a:srcRect')[0]).toEqual({ l: '90000', r: '2000', t: '5000', b: '90000' });
    expect(tagAttrs(obj, 'a:off')[0]).toEqual({ x: String(100 * 12700), y: String(100 * 12700) });
    expect(tagAttrs(obj, 'a:ext')[0]).toEqual({ cx: String(800 * 12700), cy: String(600 * 12700) });
  });

  it('flips and rotation go to xfrm', async () => {
    const { pkg } = await build(one([shape('L', 'line', tf(0, 0, 100, 50, 0, true, false), { stroke: { color: rgb('000000'), weight: 1, align: 'center', dash: null, cap: 'none', join: 'miter', startArrow: 'none', endArrow: 'arrow' } })]));
    expect(tagAttrs(objectByName(slideXml(pkg, 1), 'L'), 'a:xfrm')[0]).toEqual({ flipH: '1' });
  });
});

describe('assets', () => {
  it('JPEG assets become .jpeg media with an image/jpeg content type', async () => {
    const jpeg: Asset = { id: 'j', mime: 'image/jpeg', role: 'image-fill', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]), width: 1, height: 1 };
    const { pkg } = await build(one([image('Photo', 'j', tf(0, 0, 100, 100))], [jpeg]));
    expect(pkg.parts.filter((p) => p.startsWith('ppt/media/'))).toEqual([expect.stringMatching(/\.jpeg$/)]);
    expect(pkg.text('[Content_Types].xml')).toContain('<Default Extension="jpeg" ContentType="image/jpeg"/>');
  });

  it('the same asset on several slides is stored once', async () => {
    const d = deck('Dup', [
      slide('1:1', 'A', 100, 100, [image('I', 'png-red', tf(0, 0, 10, 10))]),
      slide('2:2', 'B', 100, 100, [image('I', 'png-red', tf(0, 0, 10, 10)), image('J', 'png-red', tf(20, 0, 10, 10))]),
    ], [red()]);
    const { pkg } = await build(d);
    expect(pkg.parts.filter((p) => p.startsWith('ppt/media/'))).toHaveLength(1);
  });

  it('missing / SVG-only assets are skipped and reported', async () => {
    const { pkg, result } = await build(one([image('Gone', 'nope', tf(0, 0, 10, 10)), image('Vector', 'svg', tf(0, 0, 10, 10))], [svgAsset('svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 1, 1)]));
    expect(countTags(slideXml(pkg, 1), 'p:pic')).toBe(0);
    expect(result.report.map((r) => r.code)).toEqual(['missing-asset', 'unsupported-asset']);
  });
});

describe('package layout', () => {
  it('no folder entries, [Content_Types].xml first, media stored, deterministic for a fixed `now`', async () => {
    const d = loadFixture('kitchen-sink');
    const a = await buildPptx(d, testOptions());
    const b = await buildPptx(d, testOptions());
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    const { pkg } = await build(d);
    const entries = Object.values(pkg.zip.files);
    expect(entries.some((f) => f.dir)).toBe(false);
    expect(entries[0].name).toBe('[Content_Types].xml');
    expect(entries[1].name).toBe('_rels/.rels');
  });
});

describe('robustness', () => {
  it('escapes layer names and strips XML-invalid characters everywhere', async () => {
    const bad = 'A & B <"quote"> ' + String.fromCharCode(0x1b) + String.fromCharCode(0xfffe);
    const d = one([
      text(bad, tf(0, 0, 100, 20), [para([run(bad, { fontFamily: 'Font & "Co"' })])]),
      image(bad, 'png-red', tf(0, 0, 10, 10)),
      shape(bad, 'rect', tf(0, 0, 10, 10), { fill: { type: 'solid', color: rgb('FF0000') } }),
    ], [red()]);
    d.slides[0].name = bad;
    d.slides[0].notes = bad;
    const { pkg } = await build(d);
    const xml = slideXml(pkg, 1);
    expect(objectNames(xml).slice(1)).toEqual(Array(3).fill('A &amp; B &lt;&quot;quote&quot;&gt; '));
    expect(xml).toContain('typeface="Font &amp; &quot;Co&quot;"');
    expect(tagAttrs(xml, 'p:cSld')[0].name).toBe('A &amp; B &lt;&quot;quote&quot;&gt; ');
  });

  it('empty deck is rejected', async () => {
    await expect(buildPptx(deck('Empty', []), testOptions())).rejects.toThrow(/no slides/);
  });

  it('unknown element types are skipped with a report entry', async () => {
    const weird = { type: 'sticker', id: 'x', name: 'Sticker', transform: tf(0, 0, 1, 1), opacity: 1 } as unknown as Element;
    const { result } = await build(one([weird]));
    expect(result.report.find((r) => r.code === 'unsupported-element')?.nodeName).toBe('Sticker');
  });

  it('text with an empty first paragraph and only soft breaks', async () => {
    const ls = String.fromCharCode(0x2028);
    const { pkg } = await build(one([text('Breaks', tf(0, 0, 100, 60), [para([]), para([run(ls + ls)])])]));
    const obj = objectByName(slideXml(pkg, 1), 'Breaks');
    expect(countTags(obj, 'a:br')).toBe(2);
    expect(countTags(obj, 'a:r')).toBe(0);
  });

  it('slide background with alpha', async () => {
    const d = one([]);
    d.slides[0].background = { type: 'solid', color: rgb('102030', 0.5) };
    const { pkg } = await build(d);
    expect(slideXml(pkg, 1)).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="102030"><a:alpha val="50000"/></a:srgbClr></a:solidFill>');
  });

  it('shadow spread is reported as approximated; group shadows are dropped with a report', async () => {
    const g = group('G', [shape('A', 'rect', tf(0, 0, 10, 10)), shape('B', 'rect', tf(20, 0, 10, 10))]);
    g.shadow = { type: 'outer', color: rgb('000000'), offsetX: 0, offsetY: 2, blur: 4, spread: 0 };
    const s = shape('S', 'rect', tf(0, 0, 10, 10), { shadow: { type: 'outer', color: rgb('000000'), offsetX: 0, offsetY: 2, blur: 4, spread: 3 } });
    const { result, pkg } = await build(one([g, s]));
    expect(result.report.map((r) => r.code).sort()).toEqual(['effect-approximated', 'effect-dropped']);
    expect(elements(slideXml(pkg, 1), 'p:sp').filter((x) => x.includes('outerShdw'))).toHaveLength(1);
  });
});
