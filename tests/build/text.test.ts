import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { resolveFont } from '../../src/fonts/mapping';
import type { Hyperlink, TextElement } from '../../src/ir/types';
import {
  applyTextCase,
  paragraphLineCount,
  paragraphLineHeightPx,
  runLang,
  shouldDisableWrap,
  textBodySpec,
  textBoxTransform,
  titleCase,
  unwrappedHeightPx,
  type TextConversionOptions,
} from '../../src/build/text';
import type { ParagraphSpec, RunProps, TextItem } from '../../src/build/textBody';
import { LS, para, rgb, run, style, text, tf } from '../fixtures/ir-builders';

function options(o: Partial<TextConversionOptions> = {}): TextConversionOptions {
  return {
    scale: 1,
    opacity: 1,
    textCase: 'cap',
    font: (family, s) => resolveFont(family, s),
    linkIndex: () => 0,
    ...o,
  };
}

const runs = (p: ParagraphSpec): Array<Extract<TextItem, { kind: 'run' }>> =>
  p.items.filter((i): i is Extract<TextItem, { kind: 'run' }> => i.kind === 'run');
const firstRun = (el: TextElement, o?: Partial<TextConversionOptions>): RunProps => runs(textBodySpec(el, options(o)).paragraphs[0])[0].props;

describe('line spacing', () => {
  it('PIXELS → spcPts of the value', () => {
    const el = text('t', tf(0, 0, 100, 20), [para([run('a', { lineHeight: { unit: 'PIXELS', value: 22 } })])]);
    expect(textBodySpec(el, options()).paragraphs[0].lnSpc).toEqual({ kind: 'pts', val: 2200 });
  });

  it('PERCENT → font size × %', () => {
    const el = text('t', tf(0, 0, 100, 20), [para([run('a', { fontSize: 21, lineHeight: { unit: 'PERCENT', value: 110 } })])]);
    expect(textBodySpec(el, options()).paragraphs[0].lnSpc).toEqual({ kind: 'pts', val: 2310 });
  });

  it('AUTO → font size × autoLineHeight (points mode)', () => {
    const el = text('t', tf(0, 0, 100, 20), [para([run('a', { fontSize: 20 })])]);
    expect(textBodySpec(el, options()).paragraphs[0].lnSpc).toEqual({ kind: 'pts', val: Math.round(20 * CONFIG.text.autoLineHeight * 100) });
  });

  it('paragraph line height = max over its runs; empty paragraph uses the end style', () => {
    const p = para([run('a', { fontSize: 10, lineHeight: { unit: 'PIXELS', value: 12 } }), run('b', { fontSize: 30, lineHeight: { unit: 'PIXELS', value: 36 } })]);
    expect(paragraphLineHeightPx(p)).toBe(36);
    const empty = para([], { endStyle: style({ lineHeight: { unit: 'PIXELS', value: 40 } }) });
    expect(paragraphLineHeightPx(empty)).toBe(40);
    const el = text('t', tf(0, 0, 100, 20), [p, empty]);
    const spec = textBodySpec(el, options());
    expect(spec.paragraphs.map((x) => x.lnSpc)).toEqual([
      { kind: 'pts', val: 3600 },
      { kind: 'pts', val: 4000 },
    ]);
  });

  it('is scaled by the slide scale', () => {
    const el = text('t', tf(0, 0, 100, 20), [para([run('a', { fontSize: 64, lineHeight: { unit: 'PIXELS', value: 80 } })])]);
    const spec = textBodySpec(el, options({ scale: 0.5 }));
    expect(spec.paragraphs[0].lnSpc).toEqual({ kind: 'pts', val: 4000 });
    expect(runs(spec.paragraphs[0])[0].props.sz).toBe(3200);
  });

  it('space after on every paragraph except the last', () => {
    const el = text('t', tf(0, 0, 100, 20), [para([run('a')], { spaceAfter: 12 }), para([run('b')], { spaceAfter: 12 })]);
    expect(textBodySpec(el, options()).paragraphs.map((p) => p.spcAft)).toEqual([1200, 0]);
  });
});

describe('run properties', () => {
  it('letter spacing −3 % of 9 px → spc −27, 0 → omitted', () => {
    expect(firstRun(text('t', tf(0, 0, 10, 10), [para([run('a', { fontSize: 9, letterSpacing: { unit: 'PERCENT', value: -3 } })])])).spc).toBe(-27);
    expect(firstRun(text('t', tf(0, 0, 10, 10), [para([run('a')])])).spc).toBe(0);
  });

  it('RIBBI faces: Semibold keeps the full name, Bold becomes b=1', () => {
    const el = text('t', tf(0, 0, 10, 10), [
      para([run('a', { fontFamily: 'SB Sans Display', fontStyle: 'Semibold' }), run('b', { fontFamily: 'SB Sans Display', fontStyle: 'Bold' })]),
    ]);
    const [a, b] = runs(textBodySpec(el, options()).paragraphs[0]);
    expect(a.props).toMatchObject({ typeface: 'SB Sans Display Semibold', b: false, i: false });
    expect(b.props).toMatchObject({ typeface: 'SB Sans Display', b: true, i: false });
  });

  it('lang per run: Cyrillic ru-RU, Latin en-US, digits follow the element', () => {
    const el = text('t', tf(0, 0, 10, 10), [para([run('Привет '), run('world '), run('2026')])]);
    expect(runs(textBodySpec(el, options()).paragraphs[0]).map((r) => r.props.lang)).toEqual(['ru-RU', 'en-US', 'ru-RU']);
    expect(runLang('42', 'en-US')).toBe('en-US');
  });

  it('empty paragraph end mark takes the element language', () => {
    const el = text('t', tf(0, 0, 10, 10), [para([run('Текст')]), para([], { endStyle: style() })]);
    expect(textBodySpec(el, options()).paragraphs[1].end.lang).toBe('ru-RU');
  });

  it('color alpha × element opacity; null color → no fill', () => {
    expect(firstRun(text('t', tf(0, 0, 10, 10), [para([run('a', { color: rgb('112233', 0.8) })])], { opacity: 0.5 }), { opacity: 0.5 }).fill?.alpha).toBeCloseTo(0.4, 10);
    expect(firstRun(text('t', tf(0, 0, 10, 10), [para([run('a', { color: null })])])).fill).toBeNull();
  });

  it('decorations, baseline, kerning', () => {
    const el = text('t', tf(0, 0, 10, 10), [
      para([run('u', { decoration: 'underline' }), run('s', { decoration: 'strikethrough' }), run('2', { baseline: 'super' }), run('x', { baseline: 'sub' })]),
    ]);
    const [u, s, sup, sub] = runs(textBodySpec(el, options()).paragraphs[0]).map((r) => r.props);
    expect([u.u, u.strike, s.u, s.strike]).toEqual([true, false, false, true]);
    expect(sup.baseline).toBe(CONFIG.pptx.superscriptBaseline);
    expect(sub.baseline).toBe(CONFIG.pptx.subscriptBaseline);
    expect(u.kern).toBe(Math.round(CONFIG.text.kernMinPt * 100));
  });

  it('hyperlinks are resolved through the callback', () => {
    const seen: Hyperlink[] = [];
    const el = text('t', tf(0, 0, 10, 10), [para([run('a'), run('b', { hyperlink: { type: 'url', url: 'https://x.y' } })])]);
    const [a, b] = runs(
      textBodySpec(
        el,
        options({
          linkIndex: (h) => {
            seen.push(h);
            return 3;
          },
        }),
      ).paragraphs[0],
    );
    expect(a.props.link).toBeNull();
    expect(b.props.link).toBe(3);
    expect(seen).toEqual([{ type: 'url', url: 'https://x.y' }]);
  });

  it('counts font usage once per run', () => {
    const calls: string[] = [];
    const el = text('t', tf(0, 0, 10, 10), [para([run(`a${LS}b`, { fontStyle: 'Bold' })])]);
    textBodySpec(el, options({ font: (f, s) => (calls.push(`${f}/${s}`), resolveFont(f, s)), endFont: (f, s) => resolveFont(f, s) }));
    expect(calls).toEqual(['Inter/Bold']);
  });
});

describe('text case', () => {
  it('UPPER → cap="all" (default) or uppercase string', () => {
    expect(applyTextCase('Hello', 'UPPER', 'cap')).toEqual({ text: 'Hello', cap: 'all' });
    expect(applyTextCase('Hello', 'UPPER', 'transform')).toEqual({ text: 'HELLO', cap: null });
  });
  it('LOWER, SMALL_CAPS, SMALL_CAPS_FORCED, ORIGINAL', () => {
    expect(applyTextCase('HeLLo', 'LOWER', 'cap')).toEqual({ text: 'hello', cap: null });
    expect(applyTextCase('Hello', 'SMALL_CAPS', 'cap')).toEqual({ text: 'Hello', cap: 'small' });
    expect(applyTextCase('Hello', 'SMALL_CAPS_FORCED', 'cap')).toEqual({ text: 'hello', cap: 'small' });
    expect(applyTextCase('Hello', 'ORIGINAL', 'cap')).toEqual({ text: 'Hello', cap: null });
  });
  it('TITLE capitalizes word starts, respecting the previous run', () => {
    expect(titleCase('hello wide-world (and «ёлки»)')).toBe('Hello Wide-World (And «Ёлки»)');
    expect(titleCase("don't stop")).toBe("Don't Stop");
    expect(titleCase('lo there', 'l')).toBe('lo There');
    const el = text('t', tf(0, 0, 10, 10), [para([run('hel', { textCase: 'TITLE' }), run('lo world', { textCase: 'TITLE' })])]);
    expect(runs(textBodySpec(el, options()).paragraphs[0]).map((r) => r.text)).toEqual(['Hel', 'lo World']);
  });
});

describe('paragraphs, lists, breaks', () => {
  it('soft breaks become <a:br> items', () => {
    const el = text('t', tf(0, 0, 10, 10), [para([run(`one${LS}two${LS}`)])]);
    const items = textBodySpec(el, options()).paragraphs[0].items;
    expect(items.map((i) => (i.kind === 'run' ? i.text : '<br>'))).toEqual(['one', '<br>', 'two', '<br>']);
    expect(paragraphLineCount(el.paragraphs[0])).toBe(3);
  });

  it('lists: marL = (level + 1) × indent, hanging indent, bullets per level, numbering', () => {
    const fs = 20;
    const indent = Math.round(fs * CONFIG.text.listIndentEm * 12700);
    const el = text('t', tf(0, 0, 10, 10), [
      para([run('a', { fontSize: fs })], { list: { type: 'unordered', level: 0 } }),
      para([run('b', { fontSize: fs })], { list: { type: 'unordered', level: 1 } }),
      para([run('c', { fontSize: fs })], { list: { type: 'ordered', level: 0 } }),
    ]);
    const [a, b, c] = textBodySpec(el, options()).paragraphs;
    expect(a).toMatchObject({ marL: indent, indent: -indent, lvl: 0, bullet: { kind: 'char', char: CONFIG.text.bulletChars[0] } });
    expect(b).toMatchObject({ marL: 2 * indent, indent: -indent, lvl: 1, bullet: { kind: 'char', char: CONFIG.text.bulletChars[1] } });
    expect(c).toMatchObject({ marL: indent, bullet: { kind: 'autonum', scheme: 'arabicPeriod' } });
  });

  it('first-line indent (EMU) and alignment', () => {
    const el = text('t', tf(0, 0, 10, 10), [para([run('a')], { firstLineIndent: 24, align: 'justify' }), para([run('b')], { align: 'center' })]);
    const [a, b] = textBodySpec(el, options()).paragraphs;
    expect(a).toMatchObject({ marL: 0, indent: 24 * 12700, lvl: null, algn: 'just', bullet: { kind: 'none' } });
    expect(b.algn).toBe('ctr');
  });

  it('vertical alignment → anchor', () => {
    expect(textBodySpec(text('t', tf(0, 0, 10, 10), [para([run('a')])], { verticalAlign: 'middle' }), options()).anchor).toBe('ctr');
    expect(textBodySpec(text('t', tf(0, 0, 10, 10), [para([run('a')])], { verticalAlign: 'bottom' }), options()).anchor).toBe('b');
  });
});

describe('wrap decision', () => {
  const line = { lineHeight: { unit: 'PIXELS' as const, value: 20 } };

  it('auto-width text never wraps', () => {
    expect(shouldDisableWrap(text('t', tf(0, 0, 50, 999), [para([run('a b c', line)])]))).toBe(true);
  });

  it('fixed box exactly one line high → no wrap; room for a second line → square', () => {
    const one = text('t', tf(0, 0, 50, 20), [para([run('a b c', line)])], { autoResize: 'HEIGHT' });
    const two = text('t', tf(0, 0, 50, 40), [para([run('a b c', line)])], { autoResize: 'HEIGHT' });
    expect(shouldDisableWrap(one)).toBe(true);
    expect(shouldDisableWrap(two)).toBe(false);
    expect(textBodySpec(two, options()).wrap).toBe('square');
  });

  it('counts soft-break lines and space after', () => {
    const paragraphs = [para([run(`a${LS}b`, line)], { spaceAfter: 10 }), para([run('c', line)])];
    expect(unwrappedHeightPx(paragraphs)).toBe(20 * 2 + 10 + 20);
    expect(shouldDisableWrap(text('t', tf(0, 0, 50, 70), paragraphs, { autoResize: 'NONE' }))).toBe(true);
    expect(shouldDisableWrap(text('t', tf(0, 0, 50, 90), paragraphs, { autoResize: 'NONE' }))).toBe(false);
  });
});

describe('text box geometry', () => {
  const slack = CONFIG.text.widthSlackPercent;

  it('auto-width text grows to the right when left-aligned', () => {
    const t = textBoxTransform(text('t', tf(100, 50, 200, 20), [para([run('a')])]), slack);
    expect(t.x).toBeCloseTo(100, 9);
    expect(t.w).toBeCloseTo(200 * (1 + slack / 100), 9);
    expect(t.y).toBeCloseTo(50, 9);
  });

  it('right-aligned grows to the left, centered grows on both sides', () => {
    const right = textBoxTransform(text('t', tf(100, 50, 200, 20), [para([run('a')], { align: 'right' })]), 10);
    expect(right.x + right.w).toBeCloseTo(300, 9);
    expect(right.w).toBeCloseTo(220, 9);
    const center = textBoxTransform(text('t', tf(100, 50, 200, 20), [para([run('a')], { align: 'center' })]), 10);
    expect(center.x + center.w / 2).toBeCloseTo(200, 9);
  });

  it('fixed-width boxes use fixedWidthSlackPercent', () => {
    const t = textBoxTransform(text('t', tf(0, 0, 200, 20), [para([run('a')])], { autoResize: 'HEIGHT' }), 10);
    expect(t.w).toBeCloseTo(200 * (1 + CONFIG.text.fixedWidthSlackPercent / 100), 9);
  });

  it('rotated box: the center moves along the rotated x axis (left edge stays put)', () => {
    const el = text('t', tf(0, 0, 200, 20, 90), [para([run('a')])]);
    const t = textBoxTransform(el, 10);
    // 90° clockwise: local +x points down the slide.
    expect(t.x + t.w / 2).toBeCloseTo(100, 9);
    expect(t.y + t.h / 2).toBeCloseTo(10 + 10, 9);
    expect(t.rotation).toBe(90);
  });
});
