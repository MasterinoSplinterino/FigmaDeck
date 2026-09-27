/**
 * Writes the IR test fixtures (tests/fixtures/*.ir.json) — deterministic, bitmaps generated with pngjs.
 *
 *   npx tsx scripts/make-fixtures.ts
 *
 * diploma       595×842  portrait award certificate (Russian text, background picture, SVG logo)
 * kitchen-sink  1920×1080 every native feature (shapes, strokes, gradient, crop, groups, lists, links…)
 * wide-5k       4992×1536 frame larger than PowerPoint's 56″ limit
 * mixed-sizes   1920×1080 + 1080×1080 + 3840×2160 in one deck
 * tiny          48×48    frame smaller than the 1″ minimum
 * startup-summit-wide  4992×1536  a real production frame ("Startup Summit — 2026", measured through the
 *               Figma Plugin API, docs/figma-api-notes.md): image-fill background, right-aligned title,
 *               three gradient cards with inner shadow + inside stroke and native Cyrillic text
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck, LinearGradientFill, Matrix } from '../src/ir/types';
import { serializeDeck } from '../src/ir/serialize';
import {
  LS,
  coverCrop,
  deck,
  group,
  image,
  para,
  pngAsset,
  rgb,
  rgbf,
  run,
  segmentDistance,
  shape,
  slide,
  stroke,
  style,
  svgAsset,
  text,
  tf,
  type Rgba,
} from '../tests/fixtures/ir-builders';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'tests/fixtures');

// ─── Shared assets ───────────────────────────────────────────────────────────

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<circle cx="32" cy="32" r="30" fill="#21A038"/>' +
  '<path d="M18 33 L28 43 L46 23" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

/** PNG fallback of LOGO_SVG at 2x (128 px). */
function logoPixel(x: number, y: number): Rgba {
  const s = 2; // px per SVG unit
  const px = (x + 0.5) / s;
  const py = (y + 0.5) / s;
  const d = Math.hypot(px - 32, py - 32);
  if (d > 30.5) return [0, 0, 0, 0];
  const edge = Math.max(0, Math.min(1, 30.5 - d)); // 1 px antialiasing
  const check = Math.min(segmentDistance(px, py, 18, 33, 28, 43), segmentDistance(px, py, 28, 43, 46, 23));
  if (check < 3) return [255, 255, 255, Math.round(255 * edge)];
  return [0x21, 0xa0, 0x38, Math.round(255 * edge)];
}

const PLAY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
  '<rect x="2" y="2" width="44" height="44" rx="10" fill="#111827"/><path d="M19 15 L34 24 L19 33 Z" fill="#F9FAFB"/></svg>';

function playPixel(x: number, y: number): Rgba {
  const px = (x + 0.5) / 2;
  const py = (y + 0.5) / 2;
  const inRect = px >= 2 && px <= 46 && py >= 2 && py <= 46;
  if (!inRect) return [0, 0, 0, 0];
  // rounded corners
  const cx = Math.min(Math.max(px, 12), 36);
  const cy = Math.min(Math.max(py, 12), 36);
  if (Math.hypot(px - cx, py - cy) > 10) return [0, 0, 0, 0];
  const inTriangle = px >= 19 && py >= 15 + ((px - 19) * 9) / 15 && py <= 33 - ((px - 19) * 9) / 15;
  return inTriangle ? [0xf9, 0xfa, 0xfb, 255] : [0x11, 0x18, 0x27, 255];
}

/** Opaque "photo": diagonal gradient with a few discs (so crops are visible). */
function photoPixel(x: number, y: number): Rgba {
  const r = Math.round(40 + (x / 400) * 180);
  const g = Math.round(80 + (y / 300) * 120);
  const b = 200 - Math.round(((x + y) / 700) * 120);
  const discs: Array<[number, number, number, Rgba]> = [
    [100, 90, 50, [250, 204, 21, 255]],
    [290, 200, 70, [239, 68, 68, 255]],
    [200, 150, 25, [255, 255, 255, 255]],
  ];
  for (const [cx, cy, rad, color] of discs) if (Math.hypot(x - cx, y - cy) < rad) return color;
  return [r, g, b, 255];
}

/** Figma gradientTransform for a linear gradient at `deg` (clockwise) through the box center. */
function gradientAt(deg: number): Matrix {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [c, s, 0.5 - 0.5 * c - 0.5 * s],
    [-s, c, 0.5 + 0.5 * s - 0.5 * c],
  ];
}

// ─── diploma ─────────────────────────────────────────────────────────────────

function diploma(): Deck {
  const W = 595;
  const H = 842;
  const bg = pngAsset(
    'bg-diploma',
    'background',
    W,
    H,
    (x, y) => {
      const border = (x >= 20 && x < 22) || (x >= W - 22 && x < W - 20) || (y >= 20 && y < 22) || (y >= H - 22 && y < H - 20);
      const inside = x >= 20 && x < W - 20 && y >= 20 && y < H - 20;
      if (border && inside) return [0xc9, 0xa5, 0x5c, 255];
      const t = y / H;
      return [Math.round(255 - 12 * t), Math.round(253 - 20 * t), Math.round(247 - 31 * t), 255];
    },
    false,
  );
  const logoPng = pngAsset('logo-png', 'vector-fallback', 128, 128, logoPixel);
  const logoSvg = svgAsset('logo-svg', LOGO_SVG, 64, 64);

  const sbText = { fontFamily: 'SB Sans Text' };
  const sbDisplay = { fontFamily: 'SB Sans Display' };
  const ink = rgb('1F1F1F');
  const gold = rgb('A8853A');

  const elements = [
    image('Background', bg.id, tf(0, 0, W, H), { rasterized: { reasons: ['exact-mode'] } }),
    image('Logo', logoPng.id, tf(48, 48, 48, 48), { svgAssetId: logoSvg.id, rasterized: { reasons: ['vector'] } }),
    text('Технологическая премия', tf(108, 60, 190, 20), [
      para([run('Технологическая премия', { ...sbText, fontStyle: 'Medium', fontWeight: 500, fontSize: 14, lineHeight: { unit: 'PIXELS', value: 20 }, color: ink })]),
    ]),
    text('Tech Awards · Москва', tf(108, 80, 150, 14), [
      para([
        run('Tech Awards · ', { ...sbText, fontSize: 10, color: rgb('6B6B6B') }),
        run('Москва', { ...sbText, fontSize: 10, color: rgb('6B6B6B') }),
      ]),
    ]),
    text('Победитель', tf(48, 290, 110, 16), [
      para([
        run('Победитель', {
          ...sbText,
          fontStyle: 'Semibold',
          fontWeight: 600,
          fontSize: 12,
          letterSpacing: { unit: 'PERCENT', value: 10 },
          lineHeight: { unit: 'PIXELS', value: 16 },
          textCase: 'UPPER',
          color: rgb('21A038'),
        }),
      ]),
    ]),
    text('Взрывной рост', tf(48, 312, 440, 64), [
      para([
        run('Взрывной рост', {
          ...sbDisplay,
          fontStyle: 'Semibold',
          fontWeight: 600,
          fontSize: 64,
          letterSpacing: { unit: 'PERCENT', value: -3 },
          lineHeight: { unit: 'PERCENT', value: 100 },
          color: rgb('111111'),
        }),
      ]),
    ]),
    text(
      'Описание',
      tf(48, 392, 300, 36),
      [
        para([
          run(
            'Премия вручается компаниям, которые за год показали кратный рост выручки и вывели на рынок продукт, изменивший отрасль.',
            { ...sbText, fontSize: 9, letterSpacing: { unit: 'PERCENT', value: -3 }, lineHeight: { unit: 'PIXELS', value: 12 }, color: rgb('4A4A4A') },
          ),
        ]),
      ],
      { autoResize: 'HEIGHT' },
    ),
    shape('Separator', 'line', tf(48, 600, 499, 0), { stroke: stroke({ color: gold, weight: 1 }) }),
    text('Иван Петров', tf(48, 620, 200, 30), [
      para([run('Иван Петров', { ...sbDisplay, fontStyle: 'Bold', fontWeight: 700, fontSize: 24, lineHeight: { unit: 'PIXELS', value: 30 }, color: ink })]),
    ]),
    text('Должность', tf(48, 652, 260, 34), [
      para([run('Генеральный директор', { ...sbText, fontSize: 12, lineHeight: { unit: 'PIXELS', value: 17 }, color: rgb('555555') })]),
      para([run('ООО «Ромашка & Партнёры»', { ...sbText, fontStyle: 'Italic', fontSize: 12, lineHeight: { unit: 'PIXELS', value: 17 }, color: rgb('555555') })]),
    ]),
    text(
      '2026',
      tf(407, 736, 140, 48),
      [para([run('2026', { ...sbDisplay, fontStyle: 'Light', fontWeight: 300, fontSize: 40, lineHeight: { unit: 'PIXELS', value: 48 }, color: gold })], { align: 'right' })],
    ),
  ];
  return deck('Диплом — Технологическая премия', [slide('10:1', 'Диплом', W, H, elements, { background: { type: 'solid', color: rgb('FFFFFF') } })], [
    bg,
    logoPng,
    logoSvg,
  ]);
}

// ─── kitchen-sink ────────────────────────────────────────────────────────────

function kitchenSink(): Deck {
  const photo = pngAsset('photo', 'image-fill', 400, 300, photoPixel, false);
  const playPng = pngAsset('play-png', 'vector-fallback', 96, 96, playPixel);
  const playSvg = svgAsset('play-svg', PLAY_SVG, 48, 48);
  const slideId = '20:1';
  const inter = { fontFamily: 'Inter' };
  const gradient: LinearGradientFill = {
    type: 'linear-gradient',
    stops: [
      { position: 0, color: rgb('6366F1') },
      { position: 0.5, color: rgb('A855F7', 0.8) },
      { position: 1, color: rgb('EC4899') },
    ],
    gradientTransform: gradientAt(30),
  };

  const lists = text(
    'Lists',
    tf(112, 552, 460, 150),
    [
      para([run('First bullet', { ...inter, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 22 } })], { list: { type: 'unordered', level: 0 } }),
      para([run('Nested bullet', { ...inter, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 22 } })], { list: { type: 'unordered', level: 1 } }),
      para([run('Step one', { ...inter, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 22 } })], { list: { type: 'ordered', level: 0 } }),
      para([run('Step two', { ...inter, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 22 } })], { list: { type: 'ordered', level: 0 } }),
      para([], { endStyle: style({ ...inter, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 22 } }) }),
      para([run(`Line one${LS}line two after a soft break`, { ...inter, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 22 } })]),
    ],
    { autoResize: 'HEIGHT' },
  );

  const cardContent = group('Card content', [
    shape('Avatar', 'ellipse', tf(112, 472, 64, 64), { fill: { type: 'solid', color: rgb('E5E7EB') } }),
    text('Card title', tf(192, 484, 300, 32), [
      para([run('Card title', { ...inter, fontStyle: 'Semi Bold', fontWeight: 600, fontSize: 24, lineHeight: { unit: 'PIXELS', value: 32 } })]),
    ]),
    lists,
  ]);
  const card = group('Card', [
    shape('Card background', 'roundRect', tf(80, 440, 520, 290), {
      cornerRadius: 16,
      fill: { type: 'solid', color: rgb('FFFFFF') },
      shadow: { type: 'outer', color: rgb('000000', 0.15), offsetX: 0, offsetY: 8, blur: 24, spread: 0 },
    }),
    cardContent,
  ]);

  const elements = [
    text('Title', tf(80, 60, 700, 88), [
      para([run('Kitchen sink', { ...inter, fontStyle: 'Bold', fontWeight: 700, fontSize: 72, lineHeight: { unit: 'PERCENT', value: 120 } })]),
    ]),
    shape('Rect', 'rect', tf(80, 200, 240, 160), {
      fill: { type: 'solid', color: rgb('3B82F6') },
      stroke: stroke({ color: rgb('1E3A8A'), weight: 4 }),
    }),
    shape('Round rect', 'roundRect', tf(360, 200, 240, 160), {
      cornerRadius: 24,
      opacity: 0.8,
      fill: { type: 'solid', color: rgb('F59E0B') },
      stroke: stroke({ color: rgb('7C2D12', 0.5), weight: 8, align: 'inside', join: 'round' }),
    }),
    shape('Ellipse', 'ellipse', tf(640, 200, 240, 160), {
      fill: { type: 'solid', color: rgb('10B981') },
      stroke: stroke({ color: rgb('064E3B'), weight: 6, align: 'outside' }),
    }),
    shape('Arrow line', 'line', tf(920, 280, 280, 0), {
      stroke: stroke({ color: rgb('111111'), weight: 4, dash: [12, 8], cap: 'round', startArrow: 'oval', endArrow: 'triangle' }),
    }),
    shape('Diagonal line', 'line', tf(920, 320, 280, 40), {
      stroke: stroke({ color: rgb('DC2626'), weight: 3, cap: 'square', join: 'bevel', endArrow: 'arrow' }),
    }),
    shape('Gradient', 'rect', tf(1240, 200, 320, 160), { fill: gradient }),
    image('Photo', photo.id, tf(1600, 200, 240, 160), {
      crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 },
      geometry: 'roundRect',
      cornerRadius: 20,
      opacity: 0.5,
    }),
    image('Round photo', photo.id, tf(1600, 380, 120, 120), { crop: { left: 0.2, top: 0.1, right: 0.3, bottom: 0.2 }, geometry: 'ellipse' }),
    card,
    text('Rotated', tf(700, 470, 300, 40, 15), [
      para([run('Rotated 15°', { ...inter, fontStyle: 'Medium', fontWeight: 500, fontSize: 28, lineHeight: { unit: 'PIXELS', value: 40 } })], { align: 'center' }),
    ]),
    text('Links', tf(700, 560, 520, 24), [
      para([
        run('Visit ', { ...inter, fontSize: 18 }),
        run('figma.com', {
          ...inter,
          fontSize: 18,
          decoration: 'underline',
          color: rgb('2563EB'),
          hyperlink: { type: 'url', url: 'https://www.figma.com/?a=1&b=2' },
        }),
        run(', ', { ...inter, fontSize: 18 }),
        run('this slide', { ...inter, fontSize: 18, decoration: 'underline', hyperlink: { type: 'node', nodeId: slideId } }),
        run(' or ', { ...inter, fontSize: 18 }),
        run('a layer', { ...inter, fontSize: 18, hyperlink: { type: 'node', nodeId: '99:99' } }),
      ]),
    ]),
    text('Upper', tf(700, 610, 300, 24), [
      para([run('uppercase via cap', { ...inter, fontStyle: 'Bold', fontSize: 20, textCase: 'UPPER', letterSpacing: { unit: 'PIXELS', value: 1.5 } })]),
    ]),
    text('Cases', tf(700, 650, 520, 24), [
      para([
        run('title case words, ', { ...inter, fontSize: 18, textCase: 'TITLE' }),
        run('LOWER ', { ...inter, fontSize: 18, textCase: 'LOWER' }),
        run('Small Caps', { ...inter, fontSize: 18, textCase: 'SMALL_CAPS' }),
      ]),
    ]),
    text('Faded', tf(700, 690, 300, 24), [para([run('Half transparent text', { ...inter, fontSize: 18, color: rgb('111111', 0.8) })])], {
      opacity: 0.5,
    }),
    text('Formula', tf(700, 730, 300, 30), [
      para([
        run('E = mc', { ...inter, fontSize: 22 }),
        run('2', { ...inter, fontSize: 22, baseline: 'super' }),
        run(' ', { ...inter, fontSize: 22 }),
        run('struck', { ...inter, fontSize: 22, decoration: 'strikethrough' }),
      ]),
    ]),
    text(
      'Justified',
      tf(700, 780, 460, 120),
      [
        para([run('Justified paragraph with a first line indent and space after. It wraps over a couple of lines inside a fixed box.', { ...inter, fontSize: 14, lineHeight: { unit: 'PERCENT', value: 140 } })], {
          align: 'justify',
          firstLineIndent: 24,
          spaceAfter: 12,
        }),
        para([run('Second paragraph, right aligned.', { ...inter, fontStyle: 'Italic', fontSize: 14 })], { align: 'right' }),
      ],
      { autoResize: 'NONE', verticalAlign: 'middle' },
    ),
    shape('Inset', 'rect', tf(1240, 440, 320, 160), {
      fill: { type: 'solid', color: rgb('F3F4F6') },
      shadow: { type: 'inner', color: rgb('000000', 0.25), offsetX: 0, offsetY: 4, blur: 8, spread: 0 },
    }),
    group('Button', [
      shape('Button background', 'roundRect', tf(1240, 640, 240, 64), {
        cornerRadius: 32,
        fill: { type: 'solid', color: rgb('111827') },
        hyperlink: { type: 'url', url: 'https://example.com/buy?x=1&y=2' },
      }),
      text(
        'Button label',
        tf(1240, 640, 240, 64),
        [para([run('Buy now', { ...inter, fontStyle: 'Semi Bold', fontSize: 20, color: rgb('FFFFFF') })], { align: 'center' })],
        { autoResize: 'NONE', verticalAlign: 'middle' },
      ),
    ]),
    image('Play icon', playPng.id, tf(1600, 560, 96, 96), { svgAssetId: playSvg.id, rasterized: { reasons: ['vector'] } }),
    shape('Dashed frame', 'roundRect', tf(1600, 700, 240, 120), {
      cornerRadius: 200, // larger than half the shorter side → clamped
      stroke: stroke({ color: rgb('6B7280'), weight: 2, dash: [6, 4, 2, 4], align: 'center' }),
    }),
  ];
  return deck('Kitchen sink', [slide(slideId, 'Kitchen sink', 1920, 1080, elements, { background: { type: 'solid', color: rgb('F4F5F7') }, notes: 'Speaker notes & <markup> stay text.' })], [
    photo,
    playPng,
    playSvg,
  ]);
}

// ─── wide-5k ─────────────────────────────────────────────────────────────────

function wide5k(): Deck {
  const photo = pngAsset('photo-wide', 'image-fill', 400, 300, photoPixel, false);
  const white = rgb('FFFFFF');
  const elements = [
    text('Headline', tf(200, 200, 900, 80), [
      para([run('Wide 5K frame', { fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 64, color: white, lineHeight: { unit: 'PIXELS', value: 80 } })]),
    ]),
    text('Subtitle', tf(200, 300, 1400, 40), [
      para([run('Exported 1 px = 1 pt this would be 69 inches wide; PowerPoint accepts at most 56.', { fontFamily: 'Inter', fontSize: 28, color: rgb('C7D2FE') })]),
    ]),
    shape('Band', 'rect', tf(0, 1200, 4992, 336), { fill: { type: 'solid', color: rgb('4F46E5') } }),
    image('Photo', photo.id, tf(4000, 200, 800, 600), { crop: { left: 0, top: 0, right: 0, bottom: 0 } }),
    text(
      'Corner label',
      tf(4592, 1400, 300, 60),
      [para([run('bottom right', { fontFamily: 'Inter', fontSize: 40, color: white })], { align: 'right' })],
      { autoResize: 'NONE' },
    ),
  ];
  return deck('Wide 5K', [slide('30:1', 'Wide 5K', 4992, 1536, elements, { background: { type: 'solid', color: rgb('0B1020') } })], [photo]);
}

// ─── mixed-sizes ─────────────────────────────────────────────────────────────

function mixedSizes(): Deck {
  const mk = (id: string, name: string, w: number, h: number, color: string) =>
    slide(
      id,
      name,
      w,
      h,
      [
        shape('Frame fill', 'rect', tf(0, 0, w, h), { fill: { type: 'solid', color: rgb(color) } }),
        text('Label', tf(w * 0.1, h * 0.1, w * 0.8, h * 0.1), [
          para([run(`${name}: ${w}×${h}`, { fontFamily: 'Inter', fontSize: Math.round(h * 0.06), color: rgb('FFFFFF') })]),
        ]),
      ],
      { background: { type: 'solid', color: rgb('FFFFFF') } },
    );
  return deck('Mixed sizes', [
    mk('40:1', 'Full HD', 1920, 1080, '0EA5E9'),
    mk('40:2', 'Square', 1080, 1080, 'F97316'),
    mk('40:3', '4K', 3840, 2160, '22C55E'),
  ]);
}

// ─── tiny ────────────────────────────────────────────────────────────────────

function tiny(): Deck {
  return deck('Tiny', [
    slide('50:1', 'Tiny', 48, 48, [
      shape('Dot', 'ellipse', tf(8, 8, 32, 32), { fill: { type: 'solid', color: rgb('E11D48') } }),
      text('Hi', tf(16, 17, 16, 14), [para([run('Hi', { fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 11, color: rgb('FFFFFF') })], { align: 'center' })]),
    ]),
  ]);
}

// ─── startup-summit-wide ─────────────────────────────────────────────────────

/** Intrinsic size of the production background image (the fixture embeds a 10× smaller PNG). */
const SUMMIT_IMAGE_W = 4096;
const SUMMIT_IMAGE_H = 1260;

/** Light background with soft green / mint glows (stand-in for the production photo), 410×126. */
function summitBackgroundPixel(x: number, y: number): Rgba {
  let c: [number, number, number] = [242, 245, 243];
  const glows: Array<[number, number, number, [number, number, number], number]> = [
    // cx, cy, radius (px of the 410×126 bitmap), color, strength
    [30, 112, 75, [33, 160, 56], 0.55],
    [388, 14, 85, [66, 225, 180], 0.45],
    [205, 150, 95, [160, 230, 200], 0.3],
  ];
  for (const [cx, cy, r, color, strength] of glows) {
    const a = strength * Math.exp(-((Math.hypot(x - cx, y - cy) / r) ** 2));
    c = [c[0] + (color[0] - c[0]) * a, c[1] + (color[1] - c[1]) * a, c[2] + (color[2] - c[2]) * a];
  }
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255];
}

/**
 * Reproduction of a real 4992×1536 frame, values as reported by the Figma Plugin API:
 * - RECTANGLE with an IMAGE fill (FILL, identity imageTransform, no filters) covering the frame;
 * - WIDTH_AND_HEIGHT title, right-aligned, SB Sans Display Regular 95.1126 px / 103 %;
 * - three auto-layout card FRAMEs 728.738×845.857: LINEAR gradient fill, SOLID INSIDE stroke 3.2533,
 *   cornerRadius 81.3324, one INNER_SHADOW (radius 130.13, offset 0, spread 0) → background shape
 *   (`~bg:<id>`) + two native texts each (224.61 px number, 60.04 px label with layer opacity 0.9).
 */
function startupSummitWide(): Deck {
  const W = 4992;
  const H = 1536;
  const bg = {
    ...pngAsset('summit-bg', 'image-fill', 410, 126, summitBackgroundPixel, false),
    displayWidth: W,
    displayHeight: H,
  };
  const sbDisplay = { fontFamily: 'SB Sans Display', fontStyle: 'Regular', fontWeight: 400 };
  const white = rgbf(1, 1, 1);
  const mint = rgbf(0.502, 0.929, 0.82);
  const cardGradient: LinearGradientFill = {
    type: 'linear-gradient',
    stops: [
      { position: 0, color: rgbf(0.1294, 0.6235, 0.4275) },
      { position: 1, color: rgbf(0.1713, 0.274, 0.1935) },
    ],
    gradientTransform: [
      [9.3e-8, 1.3925371, -6.43e-8],
      [-0.5323763, -1.09e-14, 0.8677087],
    ],
  };
  const CARD_W = 728.738;
  const CARD_H = 845.857;
  const cards = [
    // n: node id of the card frame (its texts are n + 1, n + 2)
    { n: 3150, x: 1345, y: 380, value: '9 500', spacing: -10, label: 'заявок  от стартапов' },
    { n: 3160, x: 2133, y: 380.43, value: '1 050', spacing: -10, label: 'стартапов прошли буткемп' },
    { n: 3170, x: 2921, y: 380.43, value: '175 ', spacing: -8, label: 'стартапов стали финалистами' },
  ];

  const cardGroups = cards.map((c, i) => {
    const name = `Card ${i + 1}`;
    const background = shape(name, 'roundRect', tf(c.x, c.y, CARD_W, CARD_H), {
      id: `~bg:2087:${c.n}`,
      cornerRadius: 81.3324,
      fill: cardGradient,
      stroke: stroke({ color: mint, weight: 3.2533, align: 'inside' }),
      shadow: { type: 'inner', color: mint, offsetX: 0, offsetY: 0, blur: 130.13, spread: 0 },
    });
    const value = text(
      c.value,
      tf(c.x + 81.33, c.y + 93, 566.07, 247),
      [
        para([
          run(c.value, {
            ...sbDisplay,
            fontSize: 224.61,
            letterSpacing: { unit: 'PIXELS', value: c.spacing },
            lineHeight: { unit: 'PERCENT', value: 110 },
            color: white,
          }),
        ]),
      ],
      { id: `2087:${c.n + 1}`, autoResize: 'HEIGHT' },
    );
    const label = text(
      c.label,
      tf(c.x + 81.33, c.y + 377, 566.07, 196.38),
      [
        para([
          run(c.label, {
            ...sbDisplay,
            fontSize: 60.04,
            letterSpacing: { unit: 'PERCENT', value: -3 },
            lineHeight: { unit: 'PERCENT', value: 118 },
            color: white,
          }),
        ]),
      ],
      { id: `2087:${c.n + 2}`, autoResize: 'NONE', opacity: 0.9 },
    );
    // The card frame's box (the helper's union would carry float noise from x + w).
    return { ...group(name, [background, value, label]), id: `2087:${c.n}`, transform: tf(c.x, c.y, CARD_W, CARD_H) };
  });

  const titleText = 'Sber500 в цифрах: 2018 - 2026 гг.';
  const elements = [
    image('Background', bg.id, tf(0, 0, W, H), { id: '2087:3141', crop: coverCrop(SUMMIT_IMAGE_W, SUMMIT_IMAGE_H, W, H) }),
    text(
      titleText,
      tf(1731, 169, 1532, 67),
      [
        para(
          [
            run(titleText, {
              ...sbDisplay,
              fontSize: 95.1126,
              lineHeight: { unit: 'PERCENT', value: 103 },
              letterSpacing: { unit: 'PERCENT', value: 0 },
              color: rgbf(0.053, 0.053, 0.053),
            }),
          ],
          { align: 'right' },
        ),
      ],
      { id: '2087:3142', autoResize: 'WIDTH_AND_HEIGHT' },
    ),
    ...cardGroups,
  ];
  const d = deck('Startup Summit — 2026', [slide('2087:3140', 'Sber500 в цифрах', W, H, elements, { background: { type: 'solid', color: rgb('FFFFFF') } })], [bg]);
  d.meta = { ...d.meta, sourceFile: 'Startup Summit — 2026' };
  return d;
}

export const FIXTURES: Record<string, () => Deck> = {
  diploma,
  'kitchen-sink': kitchenSink,
  'wide-5k': wide5k,
  'mixed-sizes': mixedSizes,
  tiny,
  'startup-summit-wide': startupSummitWide,
};

function main(): void {
  mkdirSync(outDir, { recursive: true });
  for (const [name, make] of Object.entries(FIXTURES)) {
    const file = resolve(outDir, `${name}.ir.json`);
    writeFileSync(file, serializeDeck(make()) + '\n');
    console.log(`wrote ${file}`);
  }
}

main();
