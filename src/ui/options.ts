/**
 * Settings plumbing (pure): ExportSettings → builder options, per-format settings adjustments,
 * font-override editing.
 */
import type { BuildOptions } from '../build/api';
import { resolveFont, type ResolvedFont } from '../fonts/mapping';
import { fontKey, normalizeSettings, type ExportFormat, type ExportSettings, type FontOverride } from '../shared/settings';

/** Builder options for an export (fresh objects every call — pptxgenjs mutates option objects). */
export function buildOptionsFromSettings(settings: ExportSettings, deckTitle: string): BuildOptions {
  const fontOverrides: Record<string, FontOverride> = {};
  for (const [key, o] of Object.entries(settings.fontOverrides)) {
    if (o && typeof o.face === 'string' && o.face.trim()) fontOverrides[key] = { face: o.face.trim(), bold: !!o.bold, italic: !!o.italic };
  }
  const options: BuildOptions = {
    textCase: settings.textCase,
    widthSlackPercent: settings.widthSlackPercent,
    fontOverrides,
    fontNaming: settings.fontNaming,
    svgVectors: settings.svgVectors,
    preserveGroups: settings.preserveGroups,
  };
  if (settings.slideSizeMode === 'custom') options.slideSize = { widthIn: settings.slideWidthIn, heightIn: settings.slideHeightIn };
  const title = deckTitle.trim();
  if (title) options.title = title;
  if (settings.author.trim()) options.author = settings.author.trim();
  if (settings.company.trim()) options.company = settings.company.trim();
  return options;
}

/**
 * Settings sent with `start-export` for a format:
 * - the image targets (PowerPoint / PDF — images) force the "Image only" extraction mode and JPEG
 *   compression (one baked picture per slide / page, at `jpegQuality`);
 * - "PowerPoint — editable" (and the IR dump that mirrors it) uses the Editable / Exact look choice;
 *   an "Image only" mode persisted by an older version counts as Editable there.
 */
export function settingsForFormat(format: ExportFormat, settings: ExportSettings): ExportSettings {
  const s = normalizeSettings({ ...settings, fontOverrides: { ...settings.fontOverrides } });
  if (format === 'pptx-image' || format === 'pdf-image') {
    s.mode = 'image';
    s.jpeg = true;
  } else if (format === 'pptx' || format === 'ir-json') {
    s.mode = editableMode(s.mode);
  }
  return s;
}

/** Mode of the "PowerPoint — editable" target: Editable or Exact look ("Image only" → Editable). */
export function editableMode(mode: ExportSettings['mode']): 'editable' | 'exact' {
  return mode === 'exact' ? 'exact' : 'editable';
}

/** Formats whose file the UI builds from extracted slides (vs. Figma's own PDF pages). */
export function isIrFormat(format: ExportFormat): boolean {
  return format !== 'pdf';
}

export interface FileKind {
  extension: string;
  mime: string;
}

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function fileKindOf(format: ExportFormat): FileKind {
  switch (format) {
    case 'pptx':
    case 'pptx-image':
      return { extension: '.pptx', mime: PPTX_MIME };
    case 'pdf':
    case 'pdf-image':
      return { extension: '.pdf', mime: 'application/pdf' };
    case 'ir-json':
      return { extension: '.figmadeck.json', mime: 'application/json' };
  }
}

/** Automatic mapping of a Figma font under the current naming rule (overrides ignored). */
export function autoFont(family: string, style: string, naming: ExportSettings['fontNaming']): ResolvedFont {
  return resolveFont(family, style, undefined, naming);
}

/** What the font-mapping row shows: the override when present, else the automatic mapping. */
export function effectiveFont(family: string, style: string, settings: Pick<ExportSettings, 'fontOverrides' | 'fontNaming'>): ResolvedFont {
  return resolveFont(family, style, settings.fontOverrides, settings.fontNaming);
}

/**
 * New overrides map after editing one row. The entry is removed when `next` is null, its face is
 * blank, or it equals the automatic mapping (so "custom" only marks real differences).
 */
export function applyFontOverride(
  overrides: Readonly<Record<string, FontOverride>>,
  family: string,
  style: string,
  next: FontOverride | null,
  auto: Pick<ResolvedFont, 'face' | 'bold' | 'italic'>,
): Record<string, FontOverride> {
  const key = fontKey(family, style);
  const out: Record<string, FontOverride> = { ...overrides };
  delete out[key];
  if (!next) return out;
  const face = next.face.trim();
  if (!face) return out;
  if (face === auto.face && !!next.bold === auto.bold && !!next.italic === auto.italic) return out;
  out[key] = { face, bold: !!next.bold, italic: !!next.italic };
  return out;
}
