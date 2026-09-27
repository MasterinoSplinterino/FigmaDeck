/**
 * IR text element → text box geometry + `TextBodySpec` (all OOXML units resolved).
 *
 * Box: Figma's text box, widened by the width slack (PowerPoint wraps the last word of an auto-width
 * Figma text otherwise) away from the alignment edge. `wrap="none"` when Figma did not wrap any line.
 * Units: px (IR) × slide scale → pt; font size / spacing in 1/100 pt, indents in EMU.
 */
import { CONFIG } from '../config';
import type { ResolvedFont } from '../fonts/mapping';
import type {
  FigmaTextCase,
  Hyperlink,
  TextElement,
  TextParagraph,
  TextRun,
  TextStyle,
  Transform,
} from '../ir/types';
import { detectLang } from '../shared/lang';
import { effectiveAlpha } from './color';
import type { EndProps, ParagraphSpec, RunProps, TextBodySpec, TextItem } from './textBody';
import { clamp, letterSpacingPx, lineHeightPx, ptToCentipoints, ptToEmu } from './units';

/** OOXML limits (ECMA-376): ST_TextFontSize, ST_TextPoint, ST_TextSpacingPoint, ST_TextMargin / ST_TextIndent. */
const SZ_MIN = 100;
const SZ_MAX = 400000;
const SPC_LIMIT = 400000;
const SPACING_MAX = 158400;
const MARGIN_MAX = 51206400;
const MAX_LIST_LEVEL = 8;

/** Characters treated as a soft line break inside a run (`<a:br/>`). ' ' is the IR's; the rest is defensive. */
const SOFT_BREAK = /\r\n|[\n\r\u000B  ]/;

export interface TextConversionOptions {
  /** px → pt factor of the slide. */
  scale: number;
  /** Element opacity 0..1 (multiplied into every run color). */
  opacity: number;
  /** UPPER handling: `cap="all"` or uppercase the string. */
  textCase: 'cap' | 'transform';
  /** Font mapping; called once per run (lets the caller count usage). */
  font: (family: string, style: string) => ResolvedFont;
  /** Font mapping for paragraph end marks (not counted as usage). */
  endFont?: (family: string, style: string) => ResolvedFont;
  /** Hyperlink → index into the slide's link table (null = dropped). */
  linkIndex: (link: Hyperlink) => number | null;
}

// ─── Metrics (px, before slide scaling) ──────────────────────────────────────

/** Line height of a paragraph: max over its runs (empty paragraph: its end style), px. */
export function paragraphLineHeightPx(p: TextParagraph): number {
  if (p.runs.length === 0) return lineHeightPx(p.endStyle);
  return Math.max(...p.runs.map((r) => lineHeightPx(r)));
}

/** Number of lines of a paragraph without wrapping (1 + soft breaks). */
export function paragraphLineCount(p: TextParagraph): number {
  let lines = 1;
  for (const r of p.runs) lines += r.text.split(SOFT_BREAK).length - 1;
  return lines;
}

/** Height of the text if no line wraps: lines × line height + space after (except the last paragraph), px. */
export function unwrappedHeightPx(paragraphs: ReadonlyArray<TextParagraph>): number {
  let total = 0;
  paragraphs.forEach((p, i) => {
    total += paragraphLineCount(p) * paragraphLineHeightPx(p);
    if (i < paragraphs.length - 1) total += Math.max(0, p.spaceAfter || 0);
  });
  return total;
}

/**
 * `wrap="none"` when Figma did not wrap any line: auto-width text, or a fixed box whose height leaves
 * no room for a wrapped line.
 */
export function shouldDisableWrap(el: TextElement): boolean {
  if (!CONFIG.text.noWrapSingleLine) return false;
  if (el.autoResize === 'WIDTH_AND_HEIGHT') return true;
  if (el.paragraphs.length === 0) return false;
  const minLineHeight = Math.min(...el.paragraphs.map(paragraphLineHeightPx));
  if (!(minLineHeight > 0)) return false;
  return el.transform.h < unwrappedHeightPx(el.paragraphs) + CONFIG.text.singleLineTolerance * minLineHeight;
}

function firstFontSizePx(el: TextElement): number {
  const p = el.paragraphs[0];
  if (!p) return 0;
  return (p.runs[0] ?? p.endStyle).fontSize;
}

/**
 * Text box in slide px: the Figma box widened by the width slack, growing away from the first
 * paragraph's alignment (left → to the right, right → to the left, center / justify → both sides),
 * plus the optional vertical nudge. For rotated boxes the center moves along the rotated axes.
 */
export function textBoxTransform(el: TextElement, widthSlackPercent: number): Transform {
  const t = el.transform;
  const slackPercent = el.autoResize === 'WIDTH_AND_HEIGHT' ? widthSlackPercent : CONFIG.text.fixedWidthSlackPercent;
  const extra = (Math.max(0, t.w) * Math.max(0, slackPercent)) / 100;
  const align = el.paragraphs[0]?.align ?? 'left';
  // Center shift in the box's local (unrotated, unflipped) frame, px.
  let dx = align === 'left' ? extra / 2 : align === 'right' ? -extra / 2 : 0;
  let dy = firstFontSizePx(el) * CONFIG.text.firstLineOffsetEm;
  if (t.flipH) dx = -dx;
  if (t.flipV) dy = -dy;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = t.x + t.w / 2 + dx * cos - dy * sin;
  const cy = t.y + t.h / 2 + dx * sin + dy * cos;
  const w = t.w + extra;
  return { ...t, x: cx - w / 2, y: cy - t.h / 2, w };
}

// ─── Text case ───────────────────────────────────────────────────────────────

const WORD_START_AFTER = /[\s\-‐-―/([{"'«“„‘]/u;
const LETTER = /\p{L}/u;

/** Uppercase the first letter of every word (CSS `capitalize`); `prev` = character before `text`. */
export function titleCase(text: string, prev = ''): string {
  let out = '';
  let before = prev;
  for (const ch of text) {
    out += LETTER.test(ch) && (before === '' || WORD_START_AFTER.test(before)) ? ch.toUpperCase() : ch;
    before = ch;
  }
  return out;
}

/** Apply Figma `textCase` to run text; returns the text to write and the `cap` attribute. */
export function applyTextCase(
  text: string,
  textCase: FigmaTextCase,
  mode: 'cap' | 'transform',
  prev = '',
): { text: string; cap: 'all' | 'small' | null } {
  switch (textCase) {
    case 'UPPER':
      return mode === 'cap' ? { text, cap: 'all' } : { text: text.toUpperCase(), cap: null };
    case 'LOWER':
      return { text: text.toLowerCase(), cap: null };
    case 'TITLE':
      return { text: titleCase(text, prev), cap: null };
    case 'SMALL_CAPS':
      return { text, cap: 'small' };
    case 'SMALL_CAPS_FORCED':
      return { text: text.toLowerCase(), cap: 'small' };
    case 'ORIGINAL':
    default:
      return { text, cap: null };
  }
}

// ─── Run / paragraph properties ──────────────────────────────────────────────

function finite(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Font size px → OOXML `sz` (1/100 pt, clamped to 1..4000 pt). */
export function fontSizeToSz(fontSizePx: number, scale: number): number {
  return clamp(ptToCentipoints(finite(fontSizePx) * scale), SZ_MIN, SZ_MAX);
}

/** Letter spacing of a style → OOXML `spc` (1/100 pt). */
export function letterSpacingToSpc(style: Pick<TextStyle, 'fontSize' | 'letterSpacing'>, scale: number): number {
  return clamp(ptToCentipoints(finite(letterSpacingPx(style)) * scale), -SPC_LIMIT, SPC_LIMIT);
}

function baselineOf(style: TextStyle): number {
  if (style.baseline === 'super') return CONFIG.pptx.superscriptBaseline;
  if (style.baseline === 'sub') return CONFIG.pptx.subscriptBaseline;
  return 0;
}

function runProps(style: TextStyle, lang: string, cap: 'all' | 'small' | null, font: ResolvedFont, link: number | null, o: TextConversionOptions): RunProps {
  return {
    lang,
    sz: fontSizeToSz(style.fontSize, o.scale),
    b: font.bold,
    i: font.italic,
    u: style.decoration === 'underline',
    strike: style.decoration === 'strikethrough',
    kern: Math.round(CONFIG.text.kernMinPt * 100),
    cap,
    spc: letterSpacingToSpc(style, o.scale),
    baseline: baselineOf(style),
    fill: style.color ? { color: style.color, alpha: effectiveAlpha(style.color, o.opacity) } : null,
    typeface: font.face,
    link,
  };
}

function lineSpacingOf(p: TextParagraph, scale: number): ParagraphSpec['lnSpc'] {
  const styles: TextStyle[] = p.runs.length > 0 ? p.runs : [p.endStyle];
  if (CONFIG.text.autoLineHeightMode === 'multiple' && styles.every((s) => s.lineHeight.unit === 'AUTO')) {
    return { kind: 'pct', val: 100000 };
  }
  return { kind: 'pts', val: clamp(ptToCentipoints(finite(paragraphLineHeightPx(p)) * scale), 0, SPACING_MAX) };
}

const ALIGN: Record<TextParagraph['align'], ParagraphSpec['algn']> = {
  left: 'l',
  center: 'ctr',
  right: 'r',
  justify: 'just',
};

function paragraphSpec(p: TextParagraph, isLast: boolean, fallbackLang: string, o: TextConversionOptions): ParagraphSpec {
  const items: TextItem[] = [];
  let prevChar = '';
  let lastLang = '';
  for (const run of p.runs) {
    const font = o.font(run.fontFamily, run.fontStyle);
    const link = run.hyperlink ? o.linkIndex(run.hyperlink) : null;
    const lang = runLang(run.text, fallbackLang);
    lastLang = lang;
    const pieces = run.text.split(SOFT_BREAK);
    pieces.forEach((piece, i) => {
      const cased = applyTextCase(piece, run.textCase, o.textCase, prevChar);
      const props = runProps(run, lang, cased.cap, font, link, o);
      if (i > 0) {
        items.push({ kind: 'br', props });
        prevChar = '\n';
      }
      if (cased.text.length > 0) {
        items.push({ kind: 'run', text: cased.text, props });
        prevChar = piece.slice(-1);
      }
    });
  }

  const style: TextStyle = p.runs[0] ?? p.endStyle;
  const fontSizePt = finite(style.fontSize) * o.scale;
  let marL = 0;
  let indent = clamp(ptToEmu(finite(p.firstLineIndent) * o.scale), -MARGIN_MAX, MARGIN_MAX);
  let lvl: number | null = null;
  let bullet: ParagraphSpec['bullet'] = { kind: 'none' };
  if (p.list) {
    const level = clamp(Math.floor(finite(p.list.level)), 0, MAX_LIST_LEVEL);
    const listIndent = ptToEmu(fontSizePt * CONFIG.text.listIndentEm);
    marL = clamp((level + 1) * listIndent, 0, MARGIN_MAX);
    indent = clamp(-listIndent, -MARGIN_MAX, MARGIN_MAX);
    lvl = level;
    bullet =
      p.list.type === 'ordered'
        ? { kind: 'autonum', scheme: 'arabicPeriod' }
        : { kind: 'char', char: CONFIG.text.bulletChars[level % CONFIG.text.bulletChars.length] ?? '•' };
  }

  const endFont = (o.endFont ?? o.font)(p.endStyle.fontFamily, p.endStyle.fontStyle);
  const end: EndProps = {
    lang: lastLang || fallbackLang,
    sz: fontSizeToSz(p.endStyle.fontSize, o.scale),
    b: endFont.bold,
    i: endFont.italic,
    typeface: endFont.face,
  };

  return {
    algn: ALIGN[p.align] ?? 'l',
    marL,
    indent,
    lvl,
    lnSpc: lineSpacingOf(p, o.scale),
    spcAft: isLast ? 0 : clamp(ptToCentipoints(Math.max(0, finite(p.spaceAfter)) * o.scale), 0, SPACING_MAX),
    bullet,
    items,
    end,
  };
}

const ANCHOR: Record<TextElement['verticalAlign'], TextBodySpec['anchor']> = { top: 't', middle: 'ctr', bottom: 'b' };

/**
 * Language of a run: detected from its own characters; runs without any letter (digits, punctuation)
 * take the element's language so "2026" in a Russian text box does not become en-US.
 */
export function runLang(text: string, elementLang: string): string {
  return LETTER.test(text) ? detectLang(text) : elementLang;
}

/** Language of the whole element (letter-less runs, end marks of empty paragraphs). */
function elementLang(el: TextElement): string {
  const all = el.paragraphs.map((p) => p.runs.map((r: TextRun) => r.text).join('')).join('\n');
  return detectLang(all);
}

/** Full text body spec of a text element. */
export function textBodySpec(el: TextElement, o: TextConversionOptions): TextBodySpec {
  const lang = elementLang(el);
  const n = el.paragraphs.length;
  return {
    wrap: shouldDisableWrap(el) ? 'none' : 'square',
    anchor: ANCHOR[el.verticalAlign] ?? 't',
    paragraphs: el.paragraphs.map((p, i) => paragraphSpec(p, i === n - 1, lang, o)),
  };
}
