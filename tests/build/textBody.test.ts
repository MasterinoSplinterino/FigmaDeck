import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import {
  endParaRPrXml,
  paragraphPropsXml,
  renderTextBody,
  runPropsXml,
  type ParagraphSpec,
  type RunProps,
  type TextBodySpec,
} from '../../src/build/textBody';

const props = (o: Partial<RunProps> = {}): RunProps => ({
  lang: 'en-US',
  sz: 1600,
  b: false,
  i: false,
  u: false,
  strike: false,
  kern: 100,
  cap: null,
  spc: 0,
  baseline: 0,
  fill: { color: { r: 0, g: 0, b: 0, a: 1 }, alpha: 1 },
  typeface: 'Inter',
  link: null,
  ...o,
});

const paragraph = (o: Partial<ParagraphSpec> = {}): ParagraphSpec => ({
  algn: 'l',
  marL: 0,
  indent: 0,
  lvl: null,
  lnSpc: { kind: 'pts', val: 2000 },
  spcAft: 0,
  bullet: { kind: 'none' },
  items: [{ kind: 'run', text: 'Hello', props: props() }],
  end: { lang: 'en-US', sz: 1600, b: false, i: false, typeface: 'Inter' },
  ...o,
});

/** Wrap in a root declaring the namespaces so the fragment can be validated. */
function wellFormed(xml: string): boolean {
  const doc =
    '<root xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    xml +
    '</root>';
  return XMLValidator.validate(doc) === true;
}

describe('runPropsXml', () => {
  it('writes attributes and children in schema order', () => {
    const xml = runPropsXml(
      props({ b: true, i: true, u: true, strike: true, cap: 'all', spc: -27, baseline: 30000, fill: { color: { r: 1, g: 0, b: 0, a: 1 }, alpha: 0.5 }, link: 0 }),
      [{ rId: 'rId7' }],
    );
    expect(xml).toMatch(/^<a:rPr lang="en-US" sz="1600" b="1" i="1" u="sng" strike="sngStrike" kern="100" cap="all" spc="-27" baseline="30000" dirty="0">/);
    const order = ['<a:solidFill>', '<a:latin ', '<a:ea ', '<a:cs ', '<a:hlinkClick '].map((t) => xml.indexOf(t));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(xml).toContain('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>');
    expect(xml).toContain('<a:hlinkClick r:id="rId7">');
    expect(wellFormed(xml)).toBe(true);
  });

  it('omits zero / default attributes', () => {
    const xml = runPropsXml(props({ kern: null }), []);
    expect(xml).not.toMatch(/ b=| i=| u=| strike=| kern=| cap=| spc=| baseline=/);
  });

  it('writes <a:noFill/> for invisible text', () => {
    expect(runPropsXml(props({ fill: null }), [])).toContain('<a:noFill/>');
  });

  it('escapes the typeface', () => {
    const xml = runPropsXml(props({ typeface: 'A & B "C" <D>' }), []);
    expect(xml).toContain('typeface="A &amp; B &quot;C&quot; &lt;D&gt;"');
    expect(wellFormed(xml)).toBe(true);
  });

  it('slide jumps carry the action, missing links are dropped', () => {
    expect(runPropsXml(props({ link: 0 }), [{ rId: 'rId3', action: 'ppaction://hlinksldjump' }])).toContain(
      '<a:hlinkClick r:id="rId3" action="ppaction://hlinksldjump">',
    );
    expect(runPropsXml(props({ link: 1 }), [{ rId: 'rId3' }, null])).not.toContain('hlinkClick');
  });
});

describe('paragraphPropsXml', () => {
  it('orders lnSpc, spcAft, bullet', () => {
    const xml = paragraphPropsXml(paragraph({ spcAft: 1200, bullet: { kind: 'char', char: '•' }, marL: 304800, indent: -304800, lvl: 0 }));
    expect(xml).toBe(
      '<a:pPr marL="304800" indent="-304800" lvl="0" algn="l"><a:lnSpc><a:spcPts val="2000"/></a:lnSpc>' +
        '<a:spcAft><a:spcPts val="1200"/></a:spcAft><a:buChar char="•"/></a:pPr>',
    );
  });

  it('writes spcPct and auto numbering', () => {
    const xml = paragraphPropsXml(paragraph({ lnSpc: { kind: 'pct', val: 100000 }, bullet: { kind: 'autonum', scheme: 'arabicPeriod' }, algn: 'just' }));
    expect(xml).toContain('<a:lnSpc><a:spcPct val="100000"/></a:lnSpc>');
    expect(xml).toContain('<a:buAutoNum type="arabicPeriod"/>');
    expect(xml).toContain('algn="just"');
  });

  it('non-list paragraphs have buNone', () => {
    expect(paragraphPropsXml(paragraph())).toContain('<a:buNone/>');
  });
});

describe('renderTextBody', () => {
  const spec = (paragraphs: ParagraphSpec[], o: Partial<TextBodySpec> = {}): TextBodySpec => ({ wrap: 'square', anchor: 't', paragraphs, ...o });

  it('zero insets, no autofit element, anchor and wrap', () => {
    const xml = renderTextBody(spec([paragraph()], { wrap: 'none', anchor: 'b' }));
    expect(xml).toMatch(/^<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="b"\/><a:lstStyle\/><a:p>/);
    expect(xml).not.toMatch(/Autofit|spAutoFit/);
    expect(wellFormed(xml)).toBe(true);
  });

  it('one <a:pPr> per paragraph, always the first child', () => {
    const xml = renderTextBody(
      spec([
        paragraph({
          items: [
            { kind: 'run', text: 'a', props: props() },
            { kind: 'run', text: 'b', props: props({ link: 0 }) },
            { kind: 'run', text: 'c', props: props() },
          ],
        }),
        paragraph({ items: [] }),
      ]),
      [{ rId: 'rId2' }],
    );
    const paras = xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [];
    expect(paras).toHaveLength(2);
    for (const p of paras) {
      expect(p.match(/<a:pPr\b/g)).toHaveLength(1);
      expect(p.startsWith('<a:p><a:pPr ')).toBe(true);
      expect(p).toMatch(/<a:endParaRPr [^>]*>.*<\/a:endParaRPr><\/a:p>$/);
    }
  });

  it('soft breaks become <a:br> with run properties, text is escaped', () => {
    const xml = renderTextBody(
      spec([
        paragraph({
          items: [
            { kind: 'run', text: 'Tom & <Jerry>', props: props() },
            { kind: 'br', props: props({ sz: 2400 }) },
            { kind: 'run', text: '"quoted" \'x\'', props: props() },
          ],
        }),
      ]),
    );
    expect(xml).toContain('<a:t>Tom &amp; &lt;Jerry&gt;</a:t></a:r><a:br><a:rPr lang="en-US" sz="2400"');
    expect(xml).toContain('<a:t>&quot;quoted&quot; &apos;x&apos;</a:t>');
    expect(wellFormed(xml)).toBe(true);
  });

  it('strips characters that are invalid in XML', () => {
    const bad = 'a' + String.fromCharCode(1) + 'b' + String.fromCharCode(0xffff) + 'c' + String.fromCharCode(0xd800);
    const xml = renderTextBody(spec([paragraph({ items: [{ kind: 'run', text: bad, props: props() }] })]));
    expect(xml).toContain('<a:t>abc</a:t>');
  });

  it('skips empty runs but keeps the paragraph', () => {
    const xml = renderTextBody(spec([paragraph({ items: [{ kind: 'run', text: '', props: props() }] })]));
    expect(xml).not.toContain('<a:r>');
    expect(xml).toContain('<a:endParaRPr');
  });

  it('end mark carries lang / size / face', () => {
    expect(endParaRPrXml({ lang: 'ru-RU', sz: 900, b: true, i: false, typeface: 'SB Sans Text' })).toBe(
      '<a:endParaRPr lang="ru-RU" sz="900" b="1" dirty="0"><a:latin typeface="SB Sans Text"/><a:ea typeface="SB Sans Text"/><a:cs typeface="SB Sans Text"/></a:endParaRPr>',
    );
  });
});
