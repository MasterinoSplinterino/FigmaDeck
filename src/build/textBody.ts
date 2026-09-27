/**
 * `<p:txBody>` generation (pure string building, no pptxgenjs).
 *
 * pptxgenjs 4.0.1 text bodies are unusable for Figma text: one `<a:pPr>` per run (schema-invalid when a
 * paragraph has several runs), no `cap`, `endParaRPr sz` of the first paragraph everywhere, hard-coded
 * `kern="0"` and unescaped font names. The builder creates the text shape with pptxgenjs (id, name, xfrm)
 * and post/ swaps in the body rendered here.
 *
 * All values in a `TextBodySpec` are final OOXML integers (EMU, 1/100 pt, 1/1000 %) — see text.ts for
 * the conversion from the IR.
 */
import type { Color } from '../ir/types';
import { srgbClrXml } from './color';
import { escapeXml } from './xml';
import { CONFIG } from '../config';

export interface RunFill {
  color: Color;
  /** Final alpha 0..1 (color alpha × element opacity). */
  alpha: number;
}

/** Character properties shared by runs, line breaks and the paragraph end mark. */
export interface RunProps {
  lang: string;
  /** Font size, 1/100 pt (100..400 000). */
  sz: number;
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  /** Minimum font size for kerning, 1/100 pt; null = attribute omitted. */
  kern: number | null;
  cap: 'all' | 'small' | null;
  /** Letter spacing, 1/100 pt; 0 = attribute omitted. */
  spc: number;
  /** Baseline shift, 1/1000 %; 0 = attribute omitted. */
  baseline: number;
  /** `null` → `<a:noFill/>` (invisible text). */
  fill: RunFill | null;
  /** PowerPoint typeface (unescaped). */
  typeface: string;
  /** Index into the slide's hyperlink table; null = none. */
  link: number | null;
}

/** Paragraph end mark (`<a:endParaRPr>`). */
export interface EndProps {
  lang: string;
  sz: number;
  b: boolean;
  i: boolean;
  typeface: string;
}

export type TextItem = { kind: 'run'; text: string; props: RunProps } | { kind: 'br'; props: RunProps };

export type LineSpacing =
  /** Exact line spacing, 1/100 pt. */
  | { kind: 'pts'; val: number }
  /** Multiple of single spacing, 1/1000 % (100 000 = single). */
  | { kind: 'pct'; val: number };

export type Bullet =
  | { kind: 'none' }
  | { kind: 'char'; char: string }
  | { kind: 'autonum'; scheme: 'arabicPeriod' };

export interface ParagraphSpec {
  algn: 'l' | 'ctr' | 'r' | 'just';
  /** Left margin, EMU. */
  marL: number;
  /** First-line indent relative to marL, EMU (negative = hanging). */
  indent: number;
  /** List level 0..8, null = attribute omitted. */
  lvl: number | null;
  lnSpc: LineSpacing | null;
  /** Space after, 1/100 pt; 0 = element omitted. */
  spcAft: number;
  bullet: Bullet;
  items: TextItem[];
  end: EndProps;
}

export interface TextBodySpec {
  wrap: 'none' | 'square';
  anchor: 't' | 'ctr' | 'b';
  paragraphs: ParagraphSpec[];
}

/** A resolved hyperlink: relationship id (+ action for slide jumps). */
export interface LinkRef {
  rId: string;
  /** `ppaction://hlinksldjump` for jumps to another slide. */
  action?: string;
}

/** Office 2019+ extension: hyperlink uses the run's own color instead of the theme's hyperlink color. */
const HLINK_TEXT_COLOR_EXT =
  '<a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}">' +
  '<ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" val="tx"/>' +
  '</a:ext></a:extLst>';

function hlinkClickXml(ref: LinkRef): string {
  const action = ref.action ? ` action="${escapeXml(ref.action)}"` : '';
  const open = `<a:hlinkClick r:id="${escapeXml(ref.rId)}"${action}`;
  return CONFIG.pptx.hyperlinkUseTextColor ? `${open}>${HLINK_TEXT_COLOR_EXT}</a:hlinkClick>` : `${open}/>`;
}

function fontsXml(typeface: string): string {
  const face = escapeXml(typeface);
  return `<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/>`;
}

/** `<a:rPr>`: attributes and children in schema order (fill, latin, ea, cs, hlinkClick). */
export function runPropsXml(p: RunProps, links: ReadonlyArray<LinkRef | null>, withLink = true): string {
  let attrs = `lang="${escapeXml(p.lang)}" sz="${p.sz}"`;
  if (p.b) attrs += ' b="1"';
  if (p.i) attrs += ' i="1"';
  if (p.u) attrs += ' u="sng"';
  if (p.strike) attrs += ' strike="sngStrike"';
  if (p.kern !== null) attrs += ` kern="${p.kern}"`;
  if (p.cap) attrs += ` cap="${p.cap}"`;
  if (p.spc !== 0) attrs += ` spc="${p.spc}"`;
  if (p.baseline !== 0) attrs += ` baseline="${p.baseline}"`;
  attrs += ' dirty="0"';
  const fill = p.fill ? `<a:solidFill>${srgbClrXml(p.fill.color, p.fill.alpha)}</a:solidFill>` : '<a:noFill/>';
  const ref = withLink && p.link !== null ? links[p.link] : null;
  const link = ref ? hlinkClickXml(ref) : '';
  return `<a:rPr ${attrs}>${fill}${fontsXml(p.typeface)}${link}</a:rPr>`;
}

export function endParaRPrXml(e: EndProps): string {
  let attrs = `lang="${escapeXml(e.lang)}" sz="${e.sz}"`;
  if (e.b) attrs += ' b="1"';
  if (e.i) attrs += ' i="1"';
  return `<a:endParaRPr ${attrs} dirty="0">${fontsXml(e.typeface)}</a:endParaRPr>`;
}

function bulletXml(b: Bullet): string {
  switch (b.kind) {
    case 'char':
      return `<a:buChar char="${escapeXml(b.char)}"/>`;
    case 'autonum':
      return `<a:buAutoNum type="${b.scheme}"/>`;
    case 'none':
    default:
      return '<a:buNone/>';
  }
}

/** `<a:pPr>`: children in schema order (lnSpc, spcBef, spcAft, bullet properties). */
export function paragraphPropsXml(p: ParagraphSpec): string {
  let attrs = `marL="${p.marL}" indent="${p.indent}"`;
  if (p.lvl !== null) attrs += ` lvl="${p.lvl}"`;
  attrs += ` algn="${p.algn}"`;
  let children = '';
  if (p.lnSpc) {
    children +=
      p.lnSpc.kind === 'pts'
        ? `<a:lnSpc><a:spcPts val="${p.lnSpc.val}"/></a:lnSpc>`
        : `<a:lnSpc><a:spcPct val="${p.lnSpc.val}"/></a:lnSpc>`;
  }
  if (p.spcAft > 0) children += `<a:spcAft><a:spcPts val="${p.spcAft}"/></a:spcAft>`;
  children += bulletXml(p.bullet);
  return `<a:pPr ${attrs}>${children}</a:pPr>`;
}

export function paragraphXml(p: ParagraphSpec, links: ReadonlyArray<LinkRef | null>): string {
  let xml = '<a:p>' + paragraphPropsXml(p);
  for (const item of p.items) {
    if (item.kind === 'br') {
      xml += `<a:br>${runPropsXml(item.props, links, false)}</a:br>`;
    } else if (item.text.length > 0) {
      xml += `<a:r>${runPropsXml(item.props, links)}<a:t>${escapeXml(item.text)}</a:t></a:r>`;
    }
  }
  return xml + endParaRPrXml(p.end) + '</a:p>';
}

/**
 * The complete `<p:txBody>`: zero insets, no autofit element, one `<a:p>` per paragraph.
 * `links[i]` resolves hyperlink index i (null = link dropped).
 */
export function renderTextBody(spec: TextBodySpec, links: ReadonlyArray<LinkRef | null> = []): string {
  const bodyPr = `<a:bodyPr wrap="${spec.wrap}" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${spec.anchor}"/>`;
  const paragraphs = spec.paragraphs.length > 0 ? spec.paragraphs.map((p) => paragraphXml(p, links)).join('') : '<a:p><a:pPr/></a:p>';
  return `<p:txBody>${bodyPr}<a:lstStyle/>${paragraphs}</p:txBody>`;
}
