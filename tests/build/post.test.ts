import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import type { ManifestGroup } from '../../src/build/manifest';
import { CONFIG } from '../../src/config';
import { groupShapeXml, wrapGroups } from '../../src/post/groups';
import { dedupeMedia, fnv1a } from '../../src/post/media';
import { addClickHyperlink, addSvgBlip, replaceFill, replaceGeometry, replaceLn, replaceTxBody, setEffectList } from '../../src/post/objects';
import { patchAppXml, patchContentTypes, patchCoreXml, patchPresentationXml, scrubGeneratorName, setElementText } from '../../src/post/package';
import { RelsEditor, parseRelationships, unescapeXml } from '../../src/post/rels';
import { fixEmptyLines, patchSlide, renameObjects } from '../../src/post/slide';
import { drawingIds, elementEnd, joinSpTree, objectName, splitSpTree } from '../../src/post/spTree';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** Shapes exactly as pptxgenjs 4.0.1 writes them. */
const SP =
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="fd:1"></p:cNvPr><p:cNvSpPr/><p:nvPr></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst></a:avLst></a:prstGeom><a:noFill/><a:ln></a:ln></p:spPr></p:sp>';
const TEXT =
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="fd:2"></p:cNvPr><p:cNvSpPr txBox="1"/><p:nvPr></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst></a:avLst></a:prstGeom><a:noFill/><a:ln></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr/><a:r><a:rPr/><a:t> </a:t></a:r><a:pPr/></a:p></p:txBody></p:sp>';
const PIC =
  '<p:pic>  <p:nvPicPr><p:cNvPr id="4" name="fd:3" descr="Logo">    </p:cNvPr>    <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>    <p:nvPr></p:nvPr>  </p:nvPicPr>' +
  '<p:blipFill><a:blip r:embed="rId1"><a:alphaModFix amt="50000"/></a:blip>  <a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr> <a:xfrm>  <a:off x="0" y="0"/>  <a:ext cx="10" cy="10"/> </a:xfrm> <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';

function slideXml(objects: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld name="Slide 1"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    objects +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image-1-1.png"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';

const wellFormed = (xml: string) => XMLValidator.validate(xml) === true;

describe('spTree splitting', () => {
  it('splits into head / objects / tail and joins back losslessly', () => {
    const xml = slideXml(SP + TEXT + PIC);
    const parts = splitSpTree(xml);
    expect(parts.objects).toHaveLength(3);
    expect(parts.objects.map(objectName)).toEqual(['fd:1', 'fd:2', 'fd:3']);
    expect(joinSpTree(parts)).toBe(xml);
  });

  it('handles nested groups and self-closing tags', () => {
    const nested = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/></p:nvGrpSpPr><p:grpSp><p:cNvPr id="8" name="h"/></p:grpSp>' + SP + '</p:grpSp>';
    const parts = splitSpTree(slideXml(nested + PIC));
    expect(parts.objects).toEqual([nested, PIC]);
    expect(elementEnd('<a:ln/><x/>', 0)).toBe(7);
  });

  it('collects drawing ids', () => {
    expect(drawingIds(slideXml(SP + TEXT + PIC))).toEqual([1, 2, 3, 4]);
  });
});

describe('object patches', () => {
  it('replaceTxBody swaps the whole body', () => {
    const out = replaceTxBody(TEXT, '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr/></a:p></p:txBody>');
    expect(out).toContain('<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr/></a:p></p:txBody></p:sp>');
    expect(out.match(/<p:txBody>/g)).toHaveLength(1);
  });

  it('replaceTxBody inserts a body after spPr when there is none', () => {
    expect(replaceTxBody(SP, '<p:txBody/>')).toMatch(/<\/p:spPr><p:txBody\/><\/p:sp>$/);
  });

  it('replaceFill replaces the fill right after the geometry', () => {
    const out = replaceFill(SP, '<a:gradFill/>');
    expect(out).toContain('</a:prstGeom><a:gradFill/><a:ln></a:ln>');
    expect(out).not.toContain('<a:noFill/>');
    const solid = SP.replace('<a:noFill/>', '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>');
    expect(replaceFill(solid, '<a:gradFill/>')).toContain('</a:prstGeom><a:gradFill/><a:ln>');
  });

  it('replaceLn replaces the line or inserts it before effects', () => {
    expect(replaceLn(SP, '<a:ln w="1"/>')).toContain('<a:noFill/><a:ln w="1"/></p:spPr>');
    expect(replaceLn(PIC, '<a:ln w="1"/>')).toContain('</a:prstGeom><a:ln w="1"/></p:spPr>');
  });

  it('replaceGeometry swaps prstGeom', () => {
    const out = replaceGeometry(PIC, '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 100"/></a:avLst></a:prstGeom>');
    expect(out).toContain('prst="roundRect"');
    expect(out).not.toContain('prst="rect"');
  });

  it('setEffectList appends at the end of spPr and replaces an existing one', () => {
    const once = setEffectList(SP, '<a:effectLst><a:outerShdw/></a:effectLst>');
    expect(once).toContain('<a:ln></a:ln><a:effectLst><a:outerShdw/></a:effectLst></p:spPr>');
    const twice = setEffectList(once, '<a:effectLst/>');
    expect(twice).toContain('<a:ln></a:ln><a:effectLst/></p:spPr>');
  });

  it('addClickHyperlink puts hlinkClick first in cNvPr (self-closing or not)', () => {
    expect(addClickHyperlink(SP, { rId: 'rId5' })).toContain('<p:cNvPr id="2" name="fd:1"><a:hlinkClick r:id="rId5"/></p:cNvPr>');
    const selfClosing = SP.replace('<p:cNvPr id="2" name="fd:1"></p:cNvPr>', '<p:cNvPr id="2" name="fd:1"/>');
    expect(addClickHyperlink(selfClosing, { rId: 'rId6', action: 'ppaction://hlinksldjump' })).toContain(
      '<p:cNvPr id="2" name="fd:1"><a:hlinkClick r:id="rId6" action="ppaction://hlinksldjump"/></p:cNvPr>',
    );
    const replaced = addClickHyperlink(addClickHyperlink(SP, { rId: 'rId5' }), { rId: 'rId9' });
    expect(replaced.match(/hlinkClick/g)).toHaveLength(1);
    expect(replaced).toContain('rId9');
  });

  it('addSvgBlip adds the extension as the last child of <a:blip>', () => {
    const out = addSvgBlip(PIC, 'rId7');
    expect(out).toContain(
      '<a:blip r:embed="rId1"><a:alphaModFix amt="50000"/><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">' +
        '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId7"/></a:ext></a:extLst></a:blip>',
    );
    const selfClosing = PIC.replace('<a:blip r:embed="rId1"><a:alphaModFix amt="50000"/></a:blip>', '<a:blip r:embed="rId1"/>');
    expect(addSvgBlip(selfClosing, 'rId7')).toMatch(/<a:blip r:embed="rId1"><a:extLst>.*<\/a:extLst><\/a:blip>/);
  });

  it('throws when an anchor is missing', () => {
    expect(() => replaceGeometry('<p:sp><p:spPr></p:spPr></p:sp>', '<x/>')).toThrow(/geometry/);
    expect(() => addSvgBlip(SP, 'rId1')).toThrow(/blip/);
  });
});

describe('relationships', () => {
  it('adds ids after the highest existing one and escapes targets', () => {
    const r = new RelsEditor(RELS);
    expect(r.add('http://t/hyperlink', 'https://a.b/?x=1&y=2', true)).toBe('rId3');
    expect(r.add('http://t/slide', 'slide2.xml')).toBe('rId4');
    const xml = r.toXml();
    expect(wellFormed(xml)).toBe(true);
    const rels = parseRelationships(xml);
    expect(rels.find((x) => x.id === 'rId3')).toEqual({ id: 'rId3', type: 'http://t/hyperlink', target: 'https://a.b/?x=1&y=2', external: true });
    expect(rels).toHaveLength(4);
  });

  it('unescapes entities', () => {
    expect(unescapeXml('a&amp;b&lt;&gt;&quot;&apos;&#65;&#x42;')).toBe('a&b<>"\'AB');
  });
});

describe('groups', () => {
  const g = (name: string, members: string[]): ManifestGroup => ({ name, layerName: name, members, bounds: { x: 1, y: 2, w: 3, h: 0 }, link: null });

  it('wraps contiguous members, nested first', () => {
    let id = 100;
    const objs = ['a', 'b', 'c', 'd'].map((n) => ({ name: n, xml: `<p:sp name="${n}"/>` }));
    const res = wrapGroups(objs, [g('inner', ['b', 'c']), g('outer', ['a', 'inner'])], () => id++, () => null);
    expect(res.skipped).toEqual([]);
    expect(res.objects.map((o) => o.name)).toEqual(['outer', 'd']);
    expect(res.objects[0].xml).toMatch(/^<p:grpSp>.*name="outer".*<p:sp name="a"\/><p:grpSp>.*name="inner".*<p:sp name="b"\/><p:sp name="c"\/><\/p:grpSp><\/p:grpSp>$/);
    expect(res.objects[0].xml).toContain('id="101"');
  });

  it('skips non-contiguous groups', () => {
    const objs = ['a', 'b', 'c'].map((n) => ({ name: n, xml: `<x n="${n}"/>` }));
    const res = wrapGroups(objs, [g('bad', ['a', 'c'])], () => 1, () => null);
    expect(res.skipped).toEqual(['bad']);
    expect(res.objects).toEqual(objs);
  });

  it('group xfrm: identity child mapping, ext at least 1', () => {
    const xml = groupShapeXml(7, 'fd:9', { x: 10, y: 20, w: 30, h: 0 }, '', { rId: 'rId3' });
    expect(xml).toContain('<p:cNvPr id="7" name="fd:9"><a:hlinkClick r:id="rId3"/></p:cNvPr>');
    expect(xml).toContain('<a:off x="10" y="20"/><a:ext cx="30" cy="1"/><a:chOff x="10" y="20"/><a:chExt cx="30" cy="1"/>');
  });
});

describe('patchSlide', () => {
  it('applies text, links, svg, groups, names; output is well-formed', () => {
    const res = patchSlide({
      xml: slideXml(SP + TEXT + PIC),
      relsXml: RELS,
      svgTargets: new Map([['svg1', '../media/fd-svg-1.svg']]),
      manifest: {
        number: 1,
        name: 'Frame & "name"',
        links: [{ type: 'url', url: 'https://x.y/?a=1&b=2' }, { type: 'slide', slideNumber: 2 }],
        objects: [
          { kind: 'shape', name: 'fd:1', layerName: 'Rect <1>', bounds: { x: 0, y: 0, w: 10, h: 10 }, link: 1, effectLst: null, fill: null, ln: '<a:ln><a:noFill/></a:ln>', geometry: null },
          {
            kind: 'text',
            name: 'fd:2',
            layerName: 'Text',
            bounds: { x: 0, y: 0, w: 10, h: 10 },
            link: null,
            effectLst: null,
            body: {
              wrap: 'none',
              anchor: 't',
              paragraphs: [
                {
                  algn: 'l',
                  marL: 0,
                  indent: 0,
                  lvl: null,
                  lnSpc: null,
                  spcAft: 0,
                  bullet: { kind: 'none' },
                  items: [
                    {
                      kind: 'run',
                      text: 'link',
                      props: { lang: 'en-US', sz: 1000, b: false, i: false, u: false, strike: false, kern: null, cap: null, spc: 0, baseline: 0, fill: null, typeface: 'Inter', link: 0 },
                    },
                  ],
                  end: { lang: 'en-US', sz: 1000, b: false, i: false, typeface: 'Inter' },
                },
              ],
            },
          },
          { kind: 'image', name: 'fd:3', layerName: 'Logo', bounds: { x: 0, y: 0, w: 10, h: 10 }, link: null, effectLst: null, geometry: null, svgAssetId: 'svg1' },
        ],
        groups: [{ name: 'fd:4', layerName: 'Group', members: ['fd:2', 'fd:3'], bounds: { x: 0, y: 0, w: 10, h: 10 }, link: null }],
      },
    });
    expect(wellFormed(res.xml)).toBe(true);
    expect(wellFormed(res.relsXml)).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(res.xml).toContain('<p:cSld name="Frame &amp; &quot;name&quot;">');
    expect(res.xml).toContain('name="Rect &lt;1&gt;"><a:hlinkClick r:id="rId4" action="ppaction://hlinksldjump"/>');
    expect(res.xml).toContain('<a:hlinkClick r:id="rId3">');
    expect(res.xml).toContain('<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId5"/>');
    expect(res.xml).toMatch(/<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"\/>/);
    expect(res.xml).not.toMatch(/name="fd:\d+"/);
    const rels = parseRelationships(res.relsXml);
    expect(rels.map((r) => [r.id, r.target])).toEqual([
      ['rId1', '../media/image-1-1.png'],
      ['rId2', '../slideLayouts/slideLayout1.xml'],
      ['rId3', 'https://x.y/?a=1&b=2'],
      ['rId4', 'slide2.xml'],
      ['rId5', '../media/fd-svg-1.svg'],
    ]);
  });

  it('fixEmptyLines and renameObjects', () => {
    expect(fixEmptyLines('<a:ln></a:ln><a:ln w="5"></a:ln><a:ln><a:noFill/></a:ln>')).toBe(
      '<a:ln><a:noFill/></a:ln><a:ln w="5"><a:noFill/></a:ln><a:ln><a:noFill/></a:ln>',
    );
    expect(renameObjects('<p:cNvPr id="2" name="fd:1"/><p:cNvPr id="3" name="fd:12"/>', new Map([['fd:1', 'A & B']]))).toBe(
      '<p:cNvPr id="2" name="A &amp; B"/><p:cNvPr id="3" name="fd:12"/>',
    );
  });
});

describe('package parts', () => {
  const meta = { title: 'Диплом & <co>', subject: '', author: 'Me', company: 'ACME', application: 'FigmaDeck', timestamp: '2026-01-02T03:04:05Z' };

  it('core.xml: metadata and timestamps', () => {
    const core =
      '<?xml version="1.0"?><cp:coreProperties xmlns:cp="cp" xmlns:dc="dc" xmlns:dcterms="dcterms" xmlns:xsi="xsi"><dc:title>PptxGenJS Presentation</dc:title><dc:subject>PptxGenJS Presentation</dc:subject>' +
      '<dc:creator>PptxGenJS</dc:creator><cp:lastModifiedBy>PptxGenJS</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">x</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">x</dcterms:modified></cp:coreProperties>';
    const out = patchCoreXml(core, meta);
    expect(out).toContain('<dc:title>Диплом &amp; &lt;co&gt;</dc:title><dc:subject></dc:subject><dc:creator>Me</dc:creator><cp:lastModifiedBy>Me</cp:lastModifiedBy>');
    expect(out).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created>');
    expect(out).not.toContain('PptxGenJS');
    expect(wellFormed(out)).toBe(true);
  });

  it('app.xml: application, format, company', () => {
    const app = '<Properties><Application>Microsoft Office PowerPoint</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Company>PptxGenJS</Company></Properties>';
    expect(patchAppXml(app, meta)).toBe('<Properties><Application>FigmaDeck</Application><PresentationFormat>Custom</PresentationFormat><Company>ACME</Company></Properties>');
  });

  it('setElementText inserts missing elements', () => {
    expect(setElementText('<r><a/></r>', 'b', 'x', '</r>')).toBe('<r><a/><b>x</b></r>');
    expect(setElementText('<r><b/></r>', 'b', 'y', '</r>')).toBe('<r><b>y</b></r>');
  });

  it('presentation.xml: portrait notes page', () => {
    expect(patchPresentationXml('<p:sldSz cx="1" cy="2"/><p:notesSz cx="2" cy="1"/>')).toBe('<p:sldSz cx="1" cy="2"/><p:notesSz cx="6858000" cy="9144000"/>');
  });

  it('content types: drops overrides of missing parts, fixes jpg, adds missing defaults', () => {
    const ct =
      '<Types xmlns="t"><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpg"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="s"/><Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="m"/></Types>';
    const out = patchContentTypes(ct, ['ppt/slides/slide1.xml', 'ppt/media/a.svg', 'ppt/media/b.png']);
    expect(out).not.toContain('slideMaster2');
    expect(out).toContain('<Default Extension="jpg" ContentType="image/jpeg"/>');
    expect(out).toContain('<Default Extension="svg" ContentType="image/svg+xml"/>');
    expect(out).toContain('<Default Extension="png" ContentType="image/png"/>');
  });

  it('scrubs the generator name', () => {
    expect(scrubGeneratorName('<a>PptxGenJS</a>')).toBe(`<a>${CONFIG.meta.application}</a>`);
  });
});

describe('media dedupe', () => {
  it('keeps one copy of identical bytes and retargets relationships', async () => {
    const zip = new JSZip();
    const a = new Uint8Array([1, 2, 3, 4]);
    zip.file('ppt/media/image-1-1.png', a);
    zip.file('ppt/media/image-2-1.png', a.slice());
    zip.file('ppt/media/image-2-2.png', new Uint8Array([9, 9]));
    zip.file('ppt/slides/_rels/slide2.xml.rels', '<R><Relationship Id="rId1" Target="../media/image-2-1.png"/><Relationship Id="rId2" Target="../media/image-2-2.png"/></R>');
    expect(await dedupeMedia(zip)).toBe(1);
    expect(zip.file('ppt/media/image-2-1.png')).toBeNull();
    expect(await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).toBe(
      '<R><Relationship Id="rId1" Target="../media/image-1-1.png"/><Relationship Id="rId2" Target="../media/image-2-2.png"/></R>',
    );
  });

  it('fnv1a is stable', () => {
    expect(fnv1a(new Uint8Array([]))).toBe(0x811c9dc5);
    expect(fnv1a(new TextEncoder().encode('a'))).toBe(0xe40c292c);
  });
});
