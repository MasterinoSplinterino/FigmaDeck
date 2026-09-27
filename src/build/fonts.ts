/**
 * Font usage tracking for the export report ("fonts the recipient must install").
 */
import { resolveFont, type ResolvedFont } from '../fonts/mapping';
import { fontKey, type FontOverride } from '../shared/settings';
import type { FontReportItem } from './api';

export class FontTracker {
  private readonly items = new Map<string, FontReportItem>();
  private readonly cache = new Map<string, ResolvedFont>();

  constructor(private readonly overrides: Record<string, FontOverride>) {}

  /** RIBBI mapping (+ user overrides) of a Figma family / style, memoized. */
  resolve(family: string, style: string): ResolvedFont {
    const key = fontKey(family, style);
    let r = this.cache.get(key);
    if (!r) {
      r = resolveFont(family, style, this.overrides);
      this.cache.set(key, r);
    }
    return r;
  }

  /** Record `runs` text runs using this font. Returns the resolved face. */
  use(family: string, style: string, runs = 1): ResolvedFont {
    const r = this.resolve(family, style);
    const key = fontKey(family, style);
    const item = this.items.get(key);
    if (item) {
      item.runs += runs;
    } else {
      this.items.set(key, { family, style, face: r.face, bold: r.bold, italic: r.italic, overridden: r.overridden, runs });
    }
    return r;
  }

  /** Report items sorted by family, then style. */
  report(): FontReportItem[] {
    return [...this.items.values()]
      .map((i) => ({ ...i }))
      .sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
  }
}
