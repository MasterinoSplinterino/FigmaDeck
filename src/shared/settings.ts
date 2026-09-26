/**
 * User-facing export settings. Persisted by the main thread in `figma.clientStorage`
 * (per user) and passed to extract (main thread) and build (UI) on every export.
 */
import { CONFIG } from '../config';

export type ExportMode =
  /** Native text, native shapes/images/groups where possible, the rest rasterized per layer. */
  | 'editable'
  /** Everything except text flattened into one background picture; native text on top. */
  | 'exact'
  /** Every slide is one picture (no editable content). */
  | 'image';

export type ExportFormat = 'pptx' | 'pdf' | 'ir-json';

export interface FontOverride {
  /** PowerPoint typeface name written to `<a:latin typeface>`. */
  face: string;
  bold: boolean;
  italic: boolean;
}

export interface ExportSettings {
  mode: ExportMode;
  /** Raster export scale. */
  rasterScale: 1 | 2 | 3;
  /** Re-encode opaque photos / backgrounds as JPEG. */
  jpeg: boolean;
  /** 0.5..1 */
  jpegQuality: number;
  /** UPPER text case: `cap` → `<a:rPr cap="all">` (text stays as typed), `transform` → uppercase the string. */
  textCase: 'cap' | 'transform';
  /** Extra width for WIDTH_AND_HEIGHT text boxes, % of width. */
  widthSlackPercent: number;
  /** Write an SVG next to the PNG fallback for vector layers. */
  svgVectors: boolean;
  /** Keep Figma groups / frames as PowerPoint groups. */
  preserveGroups: boolean;
  /** Write linear gradients natively (`<a:gradFill>`) instead of rasterizing. */
  nativeGradients: boolean;
  /** IMAGE fills: original bytes + native crop (`original`) or a raster export of the layer (`rasterize`). */
  imageFills: 'original' | 'rasterize';
  /** Partially clipped text: rasterize with the clip (`rasterize`) or keep editable and overflowing (`keep`). */
  clippedText: 'rasterize' | 'keep';
  /** Key: `${family}::${style}` (Figma names). */
  fontOverrides: Record<string, FontOverride>;
  /** Document metadata. Empty title → deck title. */
  author: string;
  company: string;
}

export const DEFAULT_SETTINGS: ExportSettings = {
  mode: 'editable',
  rasterScale: CONFIG.raster.defaultScale,
  jpeg: false,
  jpegQuality: CONFIG.raster.jpegQuality,
  textCase: 'cap',
  widthSlackPercent: CONFIG.text.widthSlackPercent,
  svgVectors: true,
  preserveGroups: true,
  nativeGradients: true,
  imageFills: 'original',
  clippedText: 'rasterize',
  fontOverrides: {},
  author: CONFIG.meta.defaultAuthor,
  company: CONFIG.meta.defaultCompany,
};

/** Merge persisted (possibly older / partial) settings with defaults and clamp values. */
export function normalizeSettings(raw: unknown): ExportSettings {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? (raw as Partial<ExportSettings>) : {}) };
  if (!['editable', 'exact', 'image'].includes(s.mode)) s.mode = DEFAULT_SETTINGS.mode;
  if (![1, 2, 3].includes(s.rasterScale)) s.rasterScale = DEFAULT_SETTINGS.rasterScale;
  if (!(s.jpegQuality >= 0.3 && s.jpegQuality <= 1)) s.jpegQuality = DEFAULT_SETTINGS.jpegQuality;
  if (!['cap', 'transform'].includes(s.textCase)) s.textCase = DEFAULT_SETTINGS.textCase;
  if (!(s.widthSlackPercent >= 0 && s.widthSlackPercent <= 20)) s.widthSlackPercent = DEFAULT_SETTINGS.widthSlackPercent;
  if (!['original', 'rasterize'].includes(s.imageFills)) s.imageFills = DEFAULT_SETTINGS.imageFills;
  if (!['rasterize', 'keep'].includes(s.clippedText)) s.clippedText = DEFAULT_SETTINGS.clippedText;
  if (!s.fontOverrides || typeof s.fontOverrides !== 'object') s.fontOverrides = {};
  s.jpeg = !!s.jpeg;
  s.svgVectors = !!s.svgVectors;
  s.preserveGroups = !!s.preserveGroups;
  s.nativeGradients = !!s.nativeGradients;
  s.author = typeof s.author === 'string' ? s.author : DEFAULT_SETTINGS.author;
  s.company = typeof s.company === 'string' ? s.company : DEFAULT_SETTINGS.company;
  return s;
}

export function fontKey(family: string, style: string): string {
  return `${family}::${style}`;
}
