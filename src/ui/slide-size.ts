/**
 * "Slide size" settings model (pure): length units, presets, the resulting PowerPoint slide size and
 * the letterbox check (frame ratio vs slide ratio). The slide size itself comes from the builder's own
 * layout (`computeDeckLayout`), so what the settings show is what the PPTX gets.
 *
 * Settings store inches (`slideWidthIn` / `slideHeightIn`); centimeters are a display unit only.
 */
import { computeDeckLayout } from '../build/layout';
import { CONFIG } from '../config';
import type { ExportSettings } from '../shared/settings';
import { formatNumber, getLang, type Lang, type MessageKey } from './i18n';

export type LengthUnit = 'cm' | 'in';

export const CM_PER_INCH = 2.54;

export function toUnit(inches: number, unit: LengthUnit): number {
  return unit === 'cm' ? inches * CM_PER_INCH : inches;
}

export function fromUnit(value: number, unit: LengthUnit): number {
  return unit === 'cm' ? value / CM_PER_INCH : value;
}

/** Precision of inputs and labels: 0.01 cm, 0.001 in. */
export function unitDecimals(unit: LengthUnit): number {
  return unit === 'cm' ? 2 : 3;
}

/** `inches` in `unit`, rounded to the unit's precision (input values). */
export function roundToUnit(inches: number, unit: LengthUnit): number {
  const f = 10 ** unitDecimals(unit);
  return Math.round(toUnit(inches, unit) * f) / f;
}

/** Localized length without unit: "87.82" / "87,82", trailing zeros dropped. */
export function formatLength(inches: number, unit: LengthUnit, lang: Lang = getLang()): string {
  return formatNumber(toUnit(inches, unit), lang, unitDecimals(unit));
}

/** Russian users think in centimeters (PowerPoint shows cm in that locale), everyone else in inches. */
export function defaultUnit(lang: Lang): LengthUnit {
  return lang === 'ru' ? 'cm' : 'in';
}

/** Clamp to PowerPoint's slide side limits (CONFIG.slide, inches). */
export function clampSlideInches(inches: number): number {
  return Math.max(CONFIG.slide.minInches, Math.min(CONFIG.slide.maxInches, inches));
}

export interface SlidePreset {
  id: 'widescreen' | 'standard' | 'led' | 'agency';
  label: MessageKey;
  widthIn: number;
  heightIn: number;
}

export const SLIDE_PRESETS: readonly SlidePreset[] = [
  // PowerPoint's own "Widescreen": 12 192 000 × 6 858 000 EMU.
  { id: 'widescreen', label: 'settings.slideSize.preset.widescreen', widthIn: 40 / 3, heightIn: 7.5 },
  { id: 'standard', label: 'settings.slideSize.preset.standard', widthIn: 10, heightIn: 7.5 },
  // 4992 × 1536 LED frames at the 56″ limit.
  { id: 'led', label: 'settings.slideSize.preset.led', widthIn: 56, heightIn: 17.23 },
  // Agency PowerPoint template 87.82 × 27.09 cm (= 31 615 200 × 9 752 400 EMU exactly).
  { id: 'agency', label: 'settings.slideSize.preset.agency', widthIn: 87.82 / CM_PER_INCH, heightIn: 27.09 / CM_PER_INCH },
];

/** The preset both sides of which are within CONFIG.ui.slidePresetToleranceIn, or null. */
export function matchPreset(widthIn: number, heightIn: number): SlidePreset | null {
  const tol = CONFIG.ui.slidePresetToleranceIn;
  return SLIDE_PRESETS.find((p) => Math.abs(p.widthIn - widthIn) <= tol && Math.abs(p.heightIn - heightIn) <= tol) ?? null;
}

const NAMED_RATIOS: ReadonlyArray<readonly [number, number]> = [
  [16, 9],
  [16, 10],
  [4, 3],
  [1, 1],
  [3, 4],
  [9, 16],
];

function ratiosDiffer(a: number, b: number): boolean {
  return Math.abs(a / b - 1) > CONFIG.ui.slideRatioTolerance;
}

/** "16:9", "4:3" for the usual ratios, otherwise "3.24:1". */
export function ratioText(ratio: number, lang: Lang = getLang()): string {
  for (const [a, b] of NAMED_RATIOS) if (!ratiosDiffer(ratio, a / b)) return `${a}:${b}`;
  return `${formatNumber(ratio, lang, 2)}:1`;
}

export interface FrameSize {
  /** px */
  width: number;
  height: number;
}

export interface SlideSizeSummary {
  /** Resulting PowerPoint slide size, inches. */
  widthIn: number;
  heightIn: number;
  /** Slide width / height. */
  ratio: number;
  /** First exported frame (it defines the size in "frame" mode). */
  first: FrameSize;
  /** Distinct frame sizes other than the first one's. */
  otherSizes: number;
  /** px → pt factor of the first frame (1 = 1 px per pt). */
  scale: number;
  frames: number;
  /** Frames whose ratio differs from the slide's (they get bars). */
  mismatched: number;
  /**
   * Bars around the first frame when EVERY frame has its size and its ratio differs from the slide's:
   * `x` = left and right, `y` = top and bottom; `barIn` = one bar, inches.
   */
  letterbox: { axis: 'x' | 'y'; barIn: number } | null;
}

/**
 * What the PPTX will get for these frames (in export order) and settings, or null without frames.
 * Uses the builder's layout: frame mode = first frame, 1 px = 1 pt, scaled into 1″…56″; custom = the
 * fixed size, every frame fitted uniformly and centered.
 */
export function summarizeSlideSize(
  frames: readonly FrameSize[],
  settings: Pick<ExportSettings, 'slideSizeMode' | 'slideWidthIn' | 'slideHeightIn'>,
): SlideSizeSummary | null {
  const valid = frames.filter((f) => f.width > 0 && f.height > 0);
  if (valid.length === 0) return null;
  const fixed = settings.slideSizeMode === 'custom' ? { widthIn: settings.slideWidthIn, heightIn: settings.slideHeightIn } : null;
  const layout = computeDeckLayout(valid, fixed);
  const inch = CONFIG.units.pxPerInch;
  const widthIn = layout.widthPt / inch;
  const heightIn = layout.heightPt / inch;
  const ratio = widthIn / heightIn;
  const first = valid[0];
  const sizes = new Set(valid.map((f) => `${f.width}x${f.height}`));
  const mismatched = valid.filter((f) => ratiosDiffer(f.width / f.height, ratio)).length;
  let letterbox: SlideSizeSummary['letterbox'] = null;
  if (sizes.size === 1 && mismatched > 0) {
    const p = layout.placements[0];
    letterbox = p.offsetX >= p.offsetY ? { axis: 'x', barIn: p.offsetX / inch } : { axis: 'y', barIn: p.offsetY / inch };
  }
  return {
    widthIn,
    heightIn,
    ratio,
    first: { width: first.width, height: first.height },
    otherSizes: sizes.size - 1,
    scale: layout.placements[0].scale,
    frames: valid.length,
    mismatched,
    letterbox,
  };
}
