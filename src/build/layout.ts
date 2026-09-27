/**
 * Deck layout: one slide size for the whole presentation and the placement of every slide in it.
 *
 * - 1 Figma px = 1 pt, slide inches = pt / 72.
 * - PowerPoint only accepts slide sides of 1″…56″ (72…4032 pt, `ST_SlideSizeCoordinate`). The first
 *   slide defines the size; when it is outside the range the whole deck gets one uniform scale
 *   `s = min(1, 4032 / longest side)`, raised to `72 / shortest side` for tiny frames.
 *   (For aspect ratios beyond 56:1 no uniform scale satisfies both limits: the longest side wins and
 *   the short side is padded to 1″, content centered.)
 * - Every other slide is fitted uniformly into that size and centered.
 * - A fixed slide size (`BuildOptions.slideSize`, e.g. an agency template 34.575″ × 10.665″) replaces
 *   the first slide's size: each side is clamped to 1″…56″ and EVERY slide is fitted uniformly
 *   (min of both ratios) and centered. The letterbox shows the slide background.
 */
import { CONFIG } from '../config';
import { clamp } from './units';

export interface SlideSize {
  /** px */
  width: number;
  height: number;
}

export interface SlidePlacement {
  /** px → pt factor for everything on this slide (positions, sizes, fonts, strokes…). */
  scale: number;
  /** Offset of the frame's top-left corner on the slide, pt. */
  offsetX: number;
  offsetY: number;
  /** The frame size differs from the first slide's. */
  sizeDiffers: boolean;
}

export interface DeckLayout {
  /** Slide size, pt (= inches × 72). */
  widthPt: number;
  heightPt: number;
  /** Uniform scale applied to the first slide (1 unless the 1″…56″ range or a fixed size forced a change). */
  deckScale: number;
  /** The slide size came from `BuildOptions.slideSize` (not from the first slide). */
  fixed: boolean;
  placements: SlidePlacement[];
}

/** Requested slide size in inches (`BuildOptions.slideSize`). */
export interface FixedSlideSize {
  widthIn: number;
  heightIn: number;
}

const MAX_PT = CONFIG.slide.maxInches * CONFIG.units.pxPerInch;
const MIN_PT = CONFIG.slide.minInches * CONFIG.units.pxPerInch;

function validSize(s: SlideSize): boolean {
  return Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0;
}

/** Uniform deck scale for a first slide of `w × h` px. */
export function deckScaleFor(w: number, h: number): number {
  const maxSide = Math.max(w, h);
  const minSide = Math.min(w, h);
  let s = Math.min(1, MAX_PT / maxSide);
  if (minSide * s < MIN_PT) s = MIN_PT / minSide;
  if (maxSide * s > MAX_PT) s = MAX_PT / maxSide; // extreme aspect ratio: the upper limit wins
  return s;
}

/**
 * Requested slide size → pt, each side clamped to 1″…56″. `null` (= derive the size from the first
 * slide) when absent or not a finite number.
 */
export function fixedSlideSizePt(size: FixedSlideSize | null | undefined): { widthPt: number; heightPt: number } | null {
  if (!size) return null;
  const w = Number(size.widthIn);
  const h = Number(size.heightIn);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const inch = CONFIG.units.pxPerInch;
  return {
    widthPt: clamp(w, CONFIG.slide.minInches, CONFIG.slide.maxInches) * inch,
    heightPt: clamp(h, CONFIG.slide.minInches, CONFIG.slide.maxInches) * inch,
  };
}

/** Fit `w × h` uniformly into `W × H` and center it. */
export function fitInto(w: number, h: number, W: number, H: number): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(W / w, H / h);
  return { scale, offsetX: (W - w * scale) / 2, offsetY: (H - h * scale) / 2 };
}

export function computeDeckLayout(sizes: ReadonlyArray<SlideSize>, slideSize?: FixedSlideSize | null): DeckLayout {
  if (sizes.length === 0) throw new Error('computeDeckLayout: the deck has no slides');
  const invalid = sizes.findIndex((s) => !validSize(s));
  if (invalid >= 0) {
    throw new Error(`computeDeckLayout: slide ${invalid + 1} has an invalid size ${sizes[invalid].width}×${sizes[invalid].height}`);
  }
  const first = sizes[0];
  const differs = (s: SlideSize, i: number) => i > 0 && (s.width !== first.width || s.height !== first.height);

  const fixed = fixedSlideSizePt(slideSize);
  if (fixed) {
    const placements = sizes.map((s, i): SlidePlacement => ({
      ...fitInto(s.width, s.height, fixed.widthPt, fixed.heightPt),
      sizeDiffers: differs(s, i),
    }));
    return { ...fixed, deckScale: placements[0].scale, fixed: true, placements };
  }

  const deckScale = deckScaleFor(first.width, first.height);
  const widthPt = clamp(first.width * deckScale, MIN_PT, MAX_PT);
  const heightPt = clamp(first.height * deckScale, MIN_PT, MAX_PT);

  const placements = sizes.map((s, i): SlidePlacement => {
    const sizeDiffers = differs(s, i);
    if (i === 0 || !sizeDiffers) {
      // Same size as the first slide: exactly the deck scale (plus padding only in the extreme-aspect case).
      return {
        scale: deckScale,
        offsetX: (widthPt - s.width * deckScale) / 2,
        offsetY: (heightPt - s.height * deckScale) / 2,
        sizeDiffers: false,
      };
    }
    return { ...fitInto(s.width, s.height, widthPt, heightPt), sizeDiffers };
  });

  return { widthPt, heightPt, deckScale, fixed: false, placements };
}
