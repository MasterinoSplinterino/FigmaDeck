/**
 * Figma font (family + style) → PowerPoint typeface, by the RIBBI rule.
 *
 * Windows groups at most four faces under one family name: Regular, Bold, Italic, Bold Italic.
 * Everything else (Light, Medium, Semibold, Black, Condensed…) is its own "family" whose name is
 * "<Family> <Style>". So:
 *   Inter / Regular          → "Inter"
 *   Inter / Bold Italic      → "Inter" + b + i
 *   SB Sans Display / Semibold        → "SB Sans Display Semibold"
 *   SB Sans Display / Semibold Italic → "SB Sans Display Semibold" + i
 *   Roboto / Condensed Bold  → "Roboto Condensed" + b
 * Users can override any mapping (BuildOptions.fontOverrides / UI "Font mapping").
 *
 * Environment-neutral (main thread, UI, Node).
 */
import { CONFIG } from '../config';
import { fontKey, type FontOverride } from '../shared/settings';

export interface ResolvedFont {
  face: string;
  bold: boolean;
  italic: boolean;
  /** Came from an explicit override. */
  overridden: boolean;
}

export interface ParsedStyle {
  /** Style without the italic marker, original spelling, e.g. "Semibold", "Condensed Bold", "". */
  weightPart: string;
  italic: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** Split the italic marker off a Figma style name. */
export function parseStyle(style: string): ParsedStyle {
  let s = (style || '').trim().replace(/\s+/g, ' ');
  let italic = false;
  // "Bold Italic", "Bold-Italic", "BoldItalic", "Italic", "Oblique"
  const m = /^(.*?)[\s_-]*(italic|oblique)$/i.exec(s);
  if (m) {
    italic = true;
    s = m[1];
  } else if (/^it$/i.test(s)) {
    italic = true;
    s = '';
  } else {
    // Adobe-style "BoldIt", "SemiboldIt", "Light It"
    const it = /^(.*?[a-z])[\s_-]?It$/.exec(s);
    if (it) {
      italic = true;
      s = it[1];
    }
  }
  // Italic in the middle ("Italic Bold") — rare, but handle it.
  if (!italic) {
    const mid = /(^|[\s_-])(italic|oblique)([\s_-]|$)/i.exec(s);
    if (mid) {
      italic = true;
      s = (s.slice(0, mid.index) + ' ' + s.slice(mid.index + mid[0].length)).trim();
    }
  }
  return { weightPart: s.replace(/[\s_-]+$/g, '').replace(/^[\s_-]+/g, ''), italic };
}

function isRegularName(part: string): boolean {
  const n = norm(part);
  if (n === '') return true;
  if (CONFIG.fonts.regularNames.includes(n)) return true;
  if (CONFIG.fonts.treatBookAsRegular && CONFIG.fonts.bookNames.includes(n)) return true;
  return false;
}

/** RIBBI mapping without overrides. */
export function ribbiFont(family: string, style: string): Omit<ResolvedFont, 'overridden'> {
  const fam = (family || '').trim();
  const { weightPart, italic } = parseStyle(style);

  if (isRegularName(weightPart)) return { face: fam, bold: false, italic };
  if (norm(weightPart) === 'bold') return { face: fam, bold: true, italic };

  // "<Width> Bold" / "<Width> Regular" → family "<Family> <Width>" (+ bold)
  const tokens = weightPart.split(/[\s_-]+/).filter(Boolean);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1].toLowerCase();
    const prev = tokens[tokens.length - 2].toLowerCase();
    const rest = weightPart.slice(0, weightPart.toLowerCase().lastIndexOf(last)).replace(/[\s_-]+$/, '');
    if (last === 'bold' && !CONFIG.fonts.boldPrefixes.includes(prev)) {
      return { face: `${fam} ${rest}`.trim(), bold: true, italic };
    }
    if (CONFIG.fonts.regularNames.includes(last)) {
      return { face: `${fam} ${rest}`.trim(), bold: false, italic };
    }
  }
  return { face: `${fam} ${weightPart}`.trim(), bold: false, italic };
}

/** RIBBI mapping, then user overrides (key `${family}::${style}`). */
export function resolveFont(
  family: string,
  style: string,
  overrides?: Record<string, FontOverride>,
): ResolvedFont {
  const o = overrides?.[fontKey(family, style)];
  if (o && o.face.trim()) return { face: o.face.trim(), bold: !!o.bold, italic: !!o.italic, overridden: true };
  return { ...ribbiFont(family, style), overridden: false };
}
