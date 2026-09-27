/**
 * Small factories for IR test data (used by scripts/make-fixtures.ts and the build tests).
 * Node only (pngjs).
 */
import { PNG } from 'pngjs';
import type {
  Asset,
  Color,
  Crop,
  Deck,
  Element,
  GroupElement,
  ImageElement,
  ShapeElement,
  Slide,
  Stroke,
  TextElement,
  TextParagraph,
  TextRun,
  TextStyle,
  Transform,
} from '../../src/ir/types';
import { IR_VERSION } from '../../src/ir/types';

/** Soft line break (U+2028) — written as a char code so editors never turn it into a real line break. */
export const LS = String.fromCharCode(0x2028);

export function rgb(hex: string, a = 1): Color {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a,
  };
}

/** Color from Figma's 0..1 channels (values as reported by the Plugin API). */
export function rgbf(r: number, g: number, b: number, a = 1): Color {
  return { r, g, b, a };
}

/**
 * Crop of an IMAGE fill with `scaleMode: 'FILL'` (cover): the `imageW × imageH` image is scaled by
 * max(boxW / imageW, boxH / imageH), centered, and the overflow is cut equally on both sides.
 * Fractions below `epsilon` are written as 0 (like the extractor's CONFIG.extract.cropEpsilon).
 */
export function coverCrop(imageW: number, imageH: number, boxW: number, boxH: number, epsilon = 1e-4): Crop {
  const s = Math.max(boxW / imageW, boxH / imageH);
  const side = (visible: number) => {
    const cut = (1 - visible) / 2;
    return Math.abs(cut) < epsilon ? 0 : cut;
  };
  const lr = side(boxW / (imageW * s));
  const tb = side(boxH / (imageH * s));
  return { left: lr, top: tb, right: lr, bottom: tb };
}

export function tf(x: number, y: number, w: number, h: number, rotation = 0, flipH = false, flipV = false): Transform {
  return { x, y, w, h, rotation, flipH, flipV };
}

export function style(o: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'Inter',
    fontStyle: 'Regular',
    fontWeight: 400,
    fontSize: 16,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    color: rgb('111111'),
    decoration: 'none',
    textCase: 'ORIGINAL',
    hyperlink: null,
    ...o,
  };
}

export function run(text: string, o: Partial<TextStyle> = {}): TextRun {
  return { ...style(o), text };
}

export function para(runs: TextRun[], o: Partial<Omit<TextParagraph, 'runs'>> = {}): TextParagraph {
  const { text: _text, ...endStyle } = runs[runs.length - 1] ?? { ...style(), text: '' };
  return {
    align: 'left',
    spaceAfter: 0,
    firstLineIndent: 0,
    list: null,
    endStyle,
    ...o,
    runs,
  };
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}:${seq}`;
}

export function text(
  name: string,
  transform: Transform,
  paragraphs: TextParagraph[],
  o: Partial<Omit<TextElement, 'type' | 'paragraphs' | 'transform' | 'name'>> = {},
): TextElement {
  return {
    type: 'text',
    id: nextId('t'),
    name,
    transform,
    opacity: 1,
    verticalAlign: 'top',
    autoResize: 'WIDTH_AND_HEIGHT',
    paragraphs,
    ...o,
  };
}

export function stroke(o: Partial<Stroke> = {}): Stroke {
  return {
    color: rgb('222222'),
    weight: 2,
    align: 'center',
    dash: null,
    cap: 'none',
    join: 'miter',
    startArrow: 'none',
    endArrow: 'none',
    ...o,
  };
}

export function shape(
  name: string,
  geometry: ShapeElement['geometry'],
  transform: Transform,
  o: Partial<Omit<ShapeElement, 'type' | 'geometry' | 'transform' | 'name'>> = {},
): ShapeElement {
  return {
    type: 'shape',
    id: nextId('s'),
    name,
    transform,
    opacity: 1,
    geometry,
    cornerRadius: 0,
    fill: null,
    stroke: null,
    ...o,
  };
}

export function image(
  name: string,
  assetId: string,
  transform: Transform,
  o: Partial<Omit<ImageElement, 'type' | 'assetId' | 'transform' | 'name'>> = {},
): ImageElement {
  return {
    type: 'image',
    id: nextId('i'),
    name,
    transform,
    opacity: 1,
    assetId,
    svgAssetId: null,
    crop: null,
    geometry: 'rect',
    cornerRadius: 0,
    ...o,
  };
}

/** Axis-aligned union of the children's (unrotated) boxes. */
export function group(name: string, children: Element[]): GroupElement {
  const x1 = Math.min(...children.map((c) => c.transform.x));
  const y1 = Math.min(...children.map((c) => c.transform.y));
  const x2 = Math.max(...children.map((c) => c.transform.x + c.transform.w));
  const y2 = Math.max(...children.map((c) => c.transform.y + c.transform.h));
  return { type: 'group', id: nextId('g'), name, transform: tf(x1, y1, x2 - x1, y2 - y1), opacity: 1, children };
}

export function slide(id: string, name: string, width: number, height: number, elements: Element[], o: Partial<Slide> = {}): Slide {
  return { id, name, width, height, background: null, elements, ...o };
}

export function deck(title: string, slides: Slide[], assets: Asset[] = []): Deck {
  return {
    irVersion: IR_VERSION,
    meta: { title, author: 'FigmaDeck tests', sourceFile: 'fixtures.fig', createdAt: '2026-01-01T00:00:00Z' },
    slides,
    assets: Object.fromEntries(assets.map((a) => [a.id, a])),
    report: [],
  };
}

// ─── Bitmaps ─────────────────────────────────────────────────────────────────

export type Rgba = [number, number, number, number];

/** Deterministic PNG from a per-pixel function (0..255 channels). */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  return new Uint8Array(PNG.sync.write(png, { colorType: 6 }));
}

export function pngAsset(id: string, role: Asset['role'], width: number, height: number, pixel: (x: number, y: number) => Rgba, hasAlpha = true): Asset {
  return { id, mime: 'image/png', role, data: makePng(width, height, pixel), width, height, hasAlpha };
}

export function svgAsset(id: string, svg: string, width: number, height: number): Asset {
  return { id, mime: 'image/svg+xml', role: 'svg', data: new TextEncoder().encode(svg), width, height };
}

/** Distance from point p to segment ab. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
