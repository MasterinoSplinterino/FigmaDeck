import { describe, expect, it } from 'vitest';
import { classifyText } from '../../src/extract/classify';
import { invert, multiply } from '../../src/extract/geometry';
import { readSegments, segmentsToParagraphs, textColor, textDefaults, type SegmentLike } from '../../src/extract/text';
import { MIXED, dropShadow, layerBlur, linear, placement, scene, solid, text } from '../helpers/figma-mocks';

const node = (props: Parameters<typeof text>[0]) => scene<TextNode>(text(props));
const rel = (n: TextNode) => multiply(invert([[1, 0, 0], [0, 1, 0]]), n.absoluteTransform);
const paragraphsOf = (props: Parameters<typeof text>[0]) => {
  const n = node(props);
  return segmentsToParagraphs(readSegments(n), textDefaults(n, MIXED));
};

describe('paragraph splitting', () => {
  it('splits on \\n across segments; the newline style becomes endStyle', () => {
    const ps = paragraphsOf({
      segments: [
        { characters: 'Hello ', fontName: { family: 'Inter', style: 'Regular' } },
        { characters: 'bold\nnext', fontName: { family: 'Inter', style: 'Bold' } },
      ],
    });
    expect(ps).toHaveLength(2);
    expect(ps[0].runs.map((r) => [r.text, r.fontStyle])).toEqual([
      ['Hello ', 'Regular'],
      ['bold', 'Bold'],
    ]);
    expect(ps[0].endStyle.fontStyle).toBe('Bold');
    expect(ps[1].runs.map((r) => r.text)).toEqual(['next']);
    expect(ps[1].endStyle.fontStyle).toBe('Bold');
  });

  it('keeps U+2028 soft breaks inside runs', () => {
    const ps = paragraphsOf({ characters: 'line one line two' });
    expect(ps).toHaveLength(1);
    expect(ps[0].runs[0].text).toBe('line one line two');
  });

  it('empty paragraphs have no runs but keep the style', () => {
    const ps = paragraphsOf({
      segments: [
        { characters: 'a\n', fontSize: 20 },
        { characters: '\n', fontSize: 30 },
        { characters: 'b\n', fontSize: 40 },
      ],
    });
    expect(ps.map((p) => p.runs.length)).toEqual([1, 0, 1, 0]);
    expect(ps.map((p) => p.endStyle.fontSize)).toEqual([20, 30, 40, 40]);
  });

  it('empty text → one empty paragraph', () => {
    const n = node({ characters: '', segments: [] });
    expect(segmentsToParagraphs([], textDefaults(n, MIXED))).toHaveLength(1);
  });

  it('merges adjacent pieces with the same style', () => {
    const ps = paragraphsOf({ segments: [{ characters: 'ab', indentation: 0 }, { characters: 'cd', indentation: 0 }] });
    expect(ps[0].runs).toHaveLength(1);
    expect(ps[0].runs[0].text).toBe('abcd');
  });
});

describe('run styles', () => {
  it('passes raw units, case, decoration, color with paint opacity', () => {
    const [p] = paragraphsOf({
      segments: [
        {
          characters: 'Title',
          fontName: { family: 'SB Sans Display', style: 'Semibold' },
          fontSize: 64,
          fontWeight: 600,
          lineHeight: { unit: 'PERCENT', value: 110 },
          letterSpacing: { unit: 'PERCENT', value: -3 },
          textCase: 'UPPER',
          textDecoration: 'UNDERLINE',
          fills: [solid('#ff0000', 0.5)],
        },
      ],
    });
    expect(p.runs[0]).toEqual({
      text: 'Title',
      fontFamily: 'SB Sans Display',
      fontStyle: 'Semibold',
      fontWeight: 600,
      fontSize: 64,
      lineHeight: { unit: 'PERCENT', value: 110 },
      letterSpacing: { unit: 'PERCENT', value: -3 },
      color: { r: 1, g: 0, b: 0, a: 0.5 },
      decoration: 'underline',
      textCase: 'UPPER',
      hyperlink: null,
    });
  });

  it('AUTO line height, pixel letter spacing, strikethrough, small caps', () => {
    const [p] = paragraphsOf({
      segments: [{ characters: 'x', lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 1.5 }, textDecoration: 'STRIKETHROUGH', textCase: 'SMALL_CAPS' }],
    });
    expect(p.runs[0]).toMatchObject({ lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 1.5 }, decoration: 'strikethrough', textCase: 'SMALL_CAPS' });
  });

  it('hyperlinks: URL and NODE', () => {
    const [p] = paragraphsOf({
      segments: [
        { characters: 'site', hyperlink: { type: 'URL', value: 'mailto:a@b.c' } },
        { characters: ' ' },
        { characters: 'slide', hyperlink: { type: 'NODE', value: '12:34' } },
      ],
    });
    expect(p.runs.map((r) => r.hyperlink)).toEqual([{ type: 'url', url: 'mailto:a@b.c' }, null, { type: 'node', nodeId: '12:34' }]);
  });

  it('superscript / subscript from OpenType features', () => {
    const [p] = paragraphsOf({ segments: [{ characters: 'x' }, { characters: '2', openTypeFeatures: { SUPS: true } }, { characters: 'i', openTypeFeatures: { SUBS: true } }] });
    expect(p.runs.map((r) => r.baseline)).toEqual([undefined, 'super', 'sub']);
  });

  it('color: first visible SOLID, null when none', () => {
    expect(textColor([solid('#000000', 1, { visible: false }), solid('#00ff00')])).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(textColor([])).toBeNull();
  });
});

describe('paragraph properties', () => {
  it('lists with 0-based levels from Figma indentation', () => {
    const ps = paragraphsOf({
      segments: [
        { characters: 'One\n', listOptions: { type: 'UNORDERED' }, indentation: 1 },
        { characters: 'Sub\n', listOptions: { type: 'UNORDERED' }, indentation: 2 },
        { characters: 'First\n', listOptions: { type: 'ORDERED' }, indentation: 1 },
        { characters: 'Plain', listOptions: { type: 'NONE' } },
      ],
    });
    expect(ps.map((p) => p.list)).toEqual([
      { type: 'unordered', level: 0 },
      { type: 'unordered', level: 1 },
      { type: 'ordered', level: 0 },
      null,
    ]);
  });

  it('spacing / indent from segments, falling back to node values; alignment', () => {
    const ps = paragraphsOf({
      textAlignHorizontal: 'JUSTIFIED',
      paragraphSpacing: 12,
      paragraphIndent: 4,
      segments: [{ characters: 'a\n', paragraphSpacing: 20 }, { characters: 'b' }],
    });
    expect(ps.map((p) => [p.align, p.spaceAfter, p.firstLineIndent])).toEqual([
      ['justify', 20, 4],
      ['justify', 12, 4],
    ]);
  });

  it('older clients: retries without newer segment fields', () => {
    const ps = paragraphsOf({ rejectFields: ['paragraphSpacing'], paragraphSpacing: 7, characters: 'x' });
    expect(ps[0].spaceAfter).toBe(7);
  });
});

describe('classifyText', () => {
  it('native text: box, alignment, auto-resize, shadow', () => {
    const n = node({
      x: 10,
      y: 20,
      width: 200,
      height: 40,
      textAlignVertical: 'CENTER',
      textAutoResize: 'WIDTH_AND_HEIGHT',
      effects: [dropShadow()],
    });
    const d = classifyText(n, MIXED, rel(n));
    expect(d.kind).toBe('native');
    expect(d.transform).toEqual({ x: 10, y: 20, w: 200, h: 40, rotation: 0, flipH: false, flipV: false });
    expect(d.verticalAlign).toBe('middle');
    expect(d.autoResize).toBe('WIDTH_AND_HEIGHT');
    expect(d.shadow?.type).toBe('outer');
  });

  it('rotated text stays native', () => {
    const n = node({ relativeTransform: placement(0, 0, 30) });
    expect(classifyText(n, MIXED, rel(n)).kind).toBe('native');
  });

  it('raster reasons', () => {
    const reasons = (props: Parameters<typeof text>[0]) => {
      const n = node(props);
      return classifyText(n, MIXED, rel(n)).reasons;
    };
    expect(reasons({ segments: [{ characters: 'g', fills: [linear()] }] })).toEqual(['gradient-text']);
    expect(reasons({ segments: [{ characters: 'g', fills: [solid(), solid('#ffffff', 0.5)] }] })).toEqual(['multiple-fills']);
    expect(reasons({ strokes: [solid()] })).toEqual(['stroke']);
    expect(reasons({ effects: [layerBlur()] })).toEqual(['blur']);
    expect(reasons({ effects: [dropShadow(), dropShadow()] })).toEqual(['effects']);
    expect(reasons({ blendMode: 'MULTIPLY' })).toEqual(['blend-mode']);
    expect(reasons({ relativeTransform: placement(100, 0, 0, true) })).toEqual(['transform']);
  });

  it('empty / invisible text → none; missing font flagged', () => {
    const empty = node({ characters: '', segments: [] });
    expect(classifyText(empty, MIXED, rel(empty)).kind).toBe('none');
    const invisible = node({ fills: [] });
    expect(classifyText(invisible, MIXED, rel(invisible)).kind).toBe('none');
    const missing = node({ hasMissingFont: true, fontName: { family: 'Nope', style: 'Bold' } });
    const d = classifyText(missing, MIXED, rel(missing));
    expect(d.kind).toBe('native');
    expect(d.hasMissingFont).toBe(true);
    expect(d.fonts).toEqual([{ family: 'Nope', style: 'Bold' }]);
  });

  it('mixed node-level values fall back to segments', () => {
    const n = node({ fontSize: MIXED, segments: [{ characters: 'a', fontSize: 10 }, { characters: 'b', fontSize: 30 }] });
    const d = classifyText(n, MIXED, rel(n));
    expect(d.paragraphs[0].runs.map((r) => r.fontSize)).toEqual([10, 30]);
  });

  it('segment fields absent everywhere use neutral defaults', () => {
    const d = textDefaults(node({ fontName: MIXED, lineHeight: MIXED }), MIXED);
    expect(d.fontName).toEqual({ family: 'Inter', style: 'Regular' });
    expect(d.lineHeight).toEqual({ unit: 'AUTO' });
    const seg: SegmentLike = { characters: 'x', start: 0, end: 1 };
    expect(segmentsToParagraphs([seg], d)[0].runs[0].fontFamily).toBe('Inter');
  });
});
