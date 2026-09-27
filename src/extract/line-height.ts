/**
 * `lineHeight: AUTO` → the font's real line height.
 *
 * Verified in Figma (docs/figma-api-notes.md): AUTO is the font's natural line height ROUNDED to whole
 * px (Inter 60 → 73, 13 → 16, 12 → 15), not a fixed multiple of the size. A temporary one-line TEXT
 * node with the same font and size (`lineHeight AUTO`, `textAutoResize WIDTH_AND_HEIGHT`) reports it as
 * its `height`. The font has to be loadable; otherwise the run keeps `{ unit: 'AUTO' }` and the
 * builder falls back to `CONFIG.text.autoLineHeight`.
 *
 * One measurement per distinct (family, style, size) and export (`LineHeightCache`, failures cached
 * too). The node is created, measured and removed synchronously after the font load, tracked in
 * `TempNodes` in between.
 */
import { CONFIG } from '../config';
import type { TextParagraph, TextStyle } from '../ir/types';
import type { FigmaEnv } from './figma-env';
import { clean } from './geometry';
import type { TempNodes } from './raster';

/** Measured AUTO line height (px) per `family \0 style \0 size`; `null` = not measurable. */
export type LineHeightCache = Map<string, Promise<number | null>>;

export type MeasureLineHeight = (font: FontName, fontSize: number) => Promise<number | null>;

export function lineHeightKey(font: FontName, fontSize: number): string {
  return `${font.family}\u0000${font.style}\u0000${fontSize}`;
}

type WritableText = TextNode & {
  fontName: FontName;
  fontSize: number;
  lineHeight: LineHeight;
  textAutoResize: TextNode['textAutoResize'];
  characters: string;
};

async function measure(env: FigmaEnv, temp: TempNodes, font: FontName, fontSize: number): Promise<number | null> {
  try {
    await env.loadFontAsync(font);
  } catch {
    return null; // missing font: keep AUTO
  }
  let node: WritableText | null = null;
  try {
    node = env.createText() as WritableText;
    temp.track(node);
    // fontName first: `characters` needs the node's CURRENT font loaded (the default one may not be).
    node.fontName = { family: font.family, style: font.style };
    node.fontSize = fontSize;
    node.lineHeight = { unit: 'AUTO' };
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
    node.characters = CONFIG.extract.autoLineHeightSample;
    const height = node.height;
    return typeof height === 'number' && isFinite(height) && height > 0 ? clean(height) : null;
  } catch {
    return null;
  } finally {
    if (node) temp.release(node);
  }
}

/** Measurement function bound to one export (shared cache, temporary nodes tracked in `temp`). */
export function createLineHeightMeasurer(env: FigmaEnv, temp: TempNodes, cache: LineHeightCache = new Map()): MeasureLineHeight {
  return (font, fontSize) => {
    if (!(fontSize > 0) || !font || !font.family) return Promise.resolve(null);
    const key = lineHeightKey(font, fontSize);
    let p = cache.get(key);
    if (!p) {
      p = measure(env, temp, font, fontSize);
      cache.set(key, p);
    }
    return p;
  };
}

async function resolveStyle(style: TextStyle, measureFn: MeasureLineHeight): Promise<void> {
  if (style.lineHeight.unit !== 'AUTO') return;
  const px = await measureFn({ family: style.fontFamily, style: style.fontStyle }, style.fontSize);
  if (px !== null) style.lineHeight = { unit: 'PIXELS', value: px };
}

/**
 * Replace AUTO line heights of every run and paragraph end style by the measured px value
 * (in place). Styles whose font cannot be measured keep AUTO.
 */
export async function resolveAutoLineHeights(paragraphs: TextParagraph[], measureFn: MeasureLineHeight): Promise<void> {
  for (const p of paragraphs) {
    for (const run of p.runs) await resolveStyle(run, measureFn);
    await resolveStyle(p.endStyle, measureFn);
  }
}
