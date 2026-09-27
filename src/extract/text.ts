/**
 * TEXT nodes → IR paragraphs / runs (Figma units kept raw; the builder converts).
 *
 * - Styles come from `getStyledTextSegments` (each segment = one uniform style range).
 * - Paragraphs split on '\n'. The '\n' character's style becomes that paragraph's `endStyle`; an
 *   empty paragraph has `runs: []`. U+2028 (Figma's soft line break, Shift+Enter) stays in the run text.
 * - Paragraph-level fields (list, indentation, spacing, indent) are read from the first segment that
 *   touches the paragraph, falling back to node-level values.
 * - Space after a paragraph: Figma separates two consecutive LIST ITEMS by `listSpacing`, every other
 *   pair of paragraphs (list item → plain paragraph included) by `paragraphSpacing`.
 */
import type {
  Color,
  FigmaLetterSpacing,
  FigmaLineHeight,
  FigmaTextCase,
  Hyperlink,
  RasterReason,
  TextList,
  TextParagraph,
  TextRun,
  TextStyle,
} from '../ir/types';
import { clean } from './geometry';
import { isNormalBlend, solidColor, visiblePaints } from './paints';

/** Fields requested from `getStyledTextSegments`, all present in plugin-typings 1.139. */
export const SEGMENT_FIELDS = [
  'fontName',
  'fontSize',
  'fontWeight',
  'fills',
  'letterSpacing',
  'lineHeight',
  'textDecoration',
  'textCase',
  'hyperlink',
  'listOptions',
  'listSpacing',
  'indentation',
  'paragraphSpacing',
  'paragraphIndent',
  'openTypeFeatures',
] as const;

/** Fallback field sets for older Figma clients that reject newer fields. */
const SEGMENT_FIELD_FALLBACKS: ReadonlyArray<ReadonlyArray<(typeof SEGMENT_FIELDS)[number]>> = [
  SEGMENT_FIELDS,
  SEGMENT_FIELDS.filter((f) => f !== 'listSpacing'),
  SEGMENT_FIELDS.filter((f) => f !== 'listSpacing' && f !== 'paragraphSpacing' && f !== 'paragraphIndent' && f !== 'openTypeFeatures'),
  ['fontName', 'fontSize', 'fills', 'letterSpacing', 'lineHeight', 'textDecoration', 'textCase', 'hyperlink'],
];

/** A styled segment as returned by Figma; every style field is optional (field sets vary). */
export interface SegmentLike {
  characters: string;
  start: number;
  end: number;
  fontName?: FontName;
  fontSize?: number;
  fontWeight?: number;
  fills?: readonly Paint[];
  letterSpacing?: LetterSpacing;
  lineHeight?: LineHeight;
  textDecoration?: TextDecoration;
  textCase?: TextCase;
  hyperlink?: HyperlinkTarget | null;
  listOptions?: TextListOptions;
  listSpacing?: number;
  indentation?: number;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  openTypeFeatures?: { readonly [feature: string]: boolean };
}

/** Node-level values used when a segment lacks a field. */
export interface TextDefaults {
  fontName: FontName;
  fontSize: number;
  fontWeight: number;
  fills: readonly Paint[];
  letterSpacing: LetterSpacing;
  lineHeight: LineHeight;
  textDecoration: TextDecoration;
  textCase: TextCase;
  paragraphSpacing: number;
  /** `null` = unknown (client without the field): list items keep `paragraphSpacing`. */
  listSpacing: number | null;
  paragraphIndent: number;
  align: TextParagraph['align'];
}

const ALIGN: Record<string, TextParagraph['align']> = {
  LEFT: 'left',
  CENTER: 'center',
  RIGHT: 'right',
  JUSTIFIED: 'justify',
};

/** Read the node's segments, retrying with smaller field sets if the client rejects a field. */
export function readSegments(node: TextNode): SegmentLike[] {
  let lastError: unknown = null;
  for (const fields of SEGMENT_FIELD_FALLBACKS) {
    try {
      return node.getStyledTextSegments([...fields]) as unknown as SegmentLike[];
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('getStyledTextSegments failed');
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** Node-level defaults (mixed values fall back to neutral ones). */
export function textDefaults(node: TextNode, mixed: symbol): TextDefaults {
  const pick = <T>(v: T | symbol, fallback: T): T => (v === mixed || v === undefined ? fallback : (v as T));
  const fills = node.fills as unknown;
  return {
    fontName: pick<FontName>(node.fontName, { family: 'Inter', style: 'Regular' }),
    fontSize: num(pick<number>(node.fontSize, 12), 12),
    fontWeight: num(pick<number>(node.fontWeight, 400), 400),
    fills: Array.isArray(fills) ? (fills as Paint[]) : [],
    letterSpacing: pick<LetterSpacing>(node.letterSpacing, { unit: 'PERCENT', value: 0 }),
    lineHeight: pick<LineHeight>(node.lineHeight, { unit: 'AUTO' }),
    textDecoration: pick<TextDecoration>(node.textDecoration, 'NONE'),
    textCase: pick<TextCase>(node.textCase, 'ORIGINAL'),
    paragraphSpacing: num(pick<number>(node.paragraphSpacing, 0), 0),
    listSpacing: finiteOrNull((node as { listSpacing?: unknown }).listSpacing),
    paragraphIndent: num(pick<number>(node.paragraphIndent, 0), 0),
    align: ALIGN[String(node.textAlignHorizontal)] ?? 'left',
  };
}

function lineHeightOf(v: LineHeight): FigmaLineHeight {
  if (v.unit === 'AUTO') return { unit: 'AUTO' };
  return { unit: v.unit, value: clean(v.value) };
}

function letterSpacingOf(v: LetterSpacing): FigmaLetterSpacing {
  return { unit: v.unit === 'PIXELS' ? 'PIXELS' : 'PERCENT', value: clean(v.value) };
}

function hyperlinkOf(h: HyperlinkTarget | null | undefined): Hyperlink | null {
  if (!h || typeof h.value !== 'string' || h.value === '') return null;
  return h.type === 'NODE' ? { type: 'node', nodeId: h.value } : { type: 'url', url: h.value };
}

/** First visible SOLID fill (paint opacity folded into alpha), `null` when none. */
export function textColor(fills: readonly Paint[]): Color | null {
  for (const p of visiblePaints(fills)) if (p.type === 'SOLID') return solidColor(p);
  return null;
}

/** Style of one segment. */
export function segmentStyle(seg: SegmentLike, d: TextDefaults): TextStyle {
  const font = seg.fontName ?? d.fontName;
  const decoration = seg.textDecoration ?? d.textDecoration;
  const style: TextStyle = {
    fontFamily: font.family,
    fontStyle: font.style,
    fontWeight: num(seg.fontWeight, d.fontWeight),
    fontSize: clean(num(seg.fontSize, d.fontSize)),
    lineHeight: lineHeightOf(seg.lineHeight ?? d.lineHeight),
    letterSpacing: letterSpacingOf(seg.letterSpacing ?? d.letterSpacing),
    color: textColor(seg.fills ?? d.fills),
    decoration: decoration === 'UNDERLINE' ? 'underline' : decoration === 'STRIKETHROUGH' ? 'strikethrough' : 'none',
    textCase: (seg.textCase ?? d.textCase) as FigmaTextCase,
    hyperlink: hyperlinkOf(seg.hyperlink),
  };
  const otf = seg.openTypeFeatures;
  if (otf?.SUPS) style.baseline = 'super';
  else if (otf?.SUBS) style.baseline = 'sub';
  return style;
}

interface ParagraphProps {
  /** `paragraphSpacing` (px); replaced by `listSpacing` between two list items (see module comment). */
  spaceAfter: number;
  firstLineIndent: number;
  list: TextList | null;
  /** Figma `listSpacing` of the paragraph, `null` when unknown. */
  listSpacing: number | null;
}

/**
 * Figma list options → IR list. Figma reports `indentation` 1 for a top-level list item and 2 for the
 * next level (typings example), so the 0-based IR level is `indentation − 1`.
 */
function paragraphProps(seg: SegmentLike, d: TextDefaults): ParagraphProps {
  const type = seg.listOptions?.type;
  const list: TextList | null =
    type === 'ORDERED' || type === 'UNORDERED'
      ? { type: type === 'ORDERED' ? 'ordered' : 'unordered', level: Math.max(0, Math.round(num(seg.indentation, 1)) - 1) }
      : null;
  const listSpacing = finiteOrNull(seg.listSpacing) ?? d.listSpacing;
  return {
    spaceAfter: clean(num(seg.paragraphSpacing, d.paragraphSpacing)),
    firstLineIndent: clean(num(seg.paragraphIndent, d.paragraphIndent)),
    list,
    listSpacing: listSpacing === null ? null : clean(listSpacing),
  };
}

/** Split styled segments into paragraphs (see module comment). Always returns ≥ 1 paragraph. */
export function segmentsToParagraphs(segments: readonly SegmentLike[], d: TextDefaults): TextParagraph[] {
  const paragraphs: TextParagraph[] = [];
  const listSpacings: Array<number | null> = [];
  let runs: TextRun[] = [];
  let props: ParagraphProps | null = null;
  let lastSeg: SegmentLike | null = null;
  let lastStyle: TextStyle | null = null;

  const close = (endStyle: TextStyle) => {
    const p =
      props ??
      (lastSeg ? paragraphProps(lastSeg, d) : { spaceAfter: d.paragraphSpacing, firstLineIndent: d.paragraphIndent, list: null, listSpacing: null });
    const { listSpacing, ...fields } = p;
    paragraphs.push({ align: d.align, ...fields, runs, endStyle });
    listSpacings.push(listSpacing);
    runs = [];
    props = null;
  };

  for (const seg of segments) {
    const style = segmentStyle(seg, d);
    const pieces = seg.characters.split('\n');
    pieces.forEach((piece, i) => {
      const lastPiece = i === pieces.length - 1;
      // Paragraph fields come from the first segment with a character of the paragraph (its text or
      // its '\n'); an empty trailing piece belongs to a paragraph that starts in the next segment.
      if (!props && (piece.length > 0 || !lastPiece || i === 0)) props = paragraphProps(seg, d);
      if (piece.length > 0) {
        const prev = runs[runs.length - 1];
        // Adjacent pieces with the same style (segments differ only in a paragraph field) merge.
        if (prev && sameStyle(prev, style)) prev.text += piece;
        else runs.push({ ...style, text: piece });
      }
      if (!lastPiece) close(style); // this piece is followed by '\n' (same style)
    });
    lastSeg = seg;
    lastStyle = style;
  }
  const tailStyle = runs.length > 0 ? stripText(runs[runs.length - 1]) : (lastStyle ?? segmentStyle({ characters: '', start: 0, end: 0 }, d));
  close(tailStyle);
  // Between two list items Figma uses the list spacing instead of the paragraph spacing.
  for (let i = 0; i + 1 < paragraphs.length; i++) {
    const listSpacing = listSpacings[i];
    if (paragraphs[i].list && paragraphs[i + 1].list && listSpacing !== null) paragraphs[i].spaceAfter = listSpacing;
  }
  return paragraphs;
}

function stripText(run: TextRun): TextStyle {
  const { text: _text, ...style } = run;
  return style;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return JSON.stringify(stripText(a as TextRun)) === JSON.stringify(stripText(b as TextRun));
}

/** Reasons the text's paint cannot be native (per segment). */
export function textPaintReasons(segments: readonly SegmentLike[], d: TextDefaults): RasterReason[] {
  const reasons: RasterReason[] = [];
  const add = (r: RasterReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  for (const seg of segments) {
    const visible = visiblePaints(seg.fills ?? d.fills);
    const nonSolid = visible.filter((p) => p.type !== 'SOLID');
    if (nonSolid.some((p) => p.type === 'IMAGE' || p.type.startsWith('GRADIENT_'))) add('gradient-text');
    if (nonSolid.some((p) => p.type !== 'IMAGE' && !p.type.startsWith('GRADIENT_'))) add('unsupported-paint'); // video, pattern…
    // Stacked solid fills blend; a single IR color cannot reproduce that.
    if (nonSolid.length === 0 && visible.length > 1) add('multiple-fills');
    if (visible.some((p) => !isNormalBlend(p.blendMode))) add('blend-mode');
  }
  return reasons;
}

/** Distinct Figma fonts of the segments (for reports). */
export function segmentFonts(segments: readonly SegmentLike[], d: TextDefaults): FontName[] {
  const seen = new Map<string, FontName>();
  for (const seg of segments) {
    const f = seg.fontName ?? d.fontName;
    seen.set(`${f.family}::${f.style}`, f);
  }
  return [...seen.values()];
}

export function verticalAlignOf(node: TextNode): 'top' | 'middle' | 'bottom' {
  return node.textAlignVertical === 'CENTER' ? 'middle' : node.textAlignVertical === 'BOTTOM' ? 'bottom' : 'top';
}

export function autoResizeOf(node: TextNode): 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE' {
  const v = node.textAutoResize;
  return v === 'WIDTH_AND_HEIGHT' || v === 'HEIGHT' || v === 'TRUNCATE' ? v : 'NONE';
}
