/**
 * Public contract of the builder (implemented in build/index.ts).
 *
 *   buildPptx(deck: Deck, options: BuildOptions, onProgress?): Promise<BuildResult>
 *
 * Must run in Node (tests) and in the browser (UI iframe): no DOM, no Node built-ins,
 * only pptxgenjs + JSZip + our own modules.
 */
import type { ReportEntry } from '../ir/types';
import type { FontOverride } from '../shared/settings';

export interface BuildOptions {
  /** UPPER text case handling. */
  textCase: 'cap' | 'transform';
  /** Extra width for WIDTH_AND_HEIGHT text boxes, % of width. */
  widthSlackPercent: number;
  /** Key `${family}::${style}` → PowerPoint face. Missing keys use the RIBBI rule. */
  fontOverrides: Record<string, FontOverride>;
  /** Write SVG blips for images that have `svgAssetId`. */
  svgVectors: boolean;
  /** Wrap GroupElement children in <p:grpSp>. When false, groups are flattened. */
  preserveGroups: boolean;
  /** Metadata; falls back to deck.meta, then CONFIG.meta. */
  author?: string;
  company?: string;
  title?: string;
  subject?: string;
  /** Fixed timestamp for docProps (tests); default = now. */
  now?: Date;
}

export interface BuildProgress {
  phase: 'slides' | 'package' | 'post';
  done: number;
  total: number;
}

export interface FontReportItem {
  /** Figma names */
  family: string;
  style: string;
  /** What was written to the PPTX */
  face: string;
  bold: boolean;
  italic: boolean;
  /** true when taken from BuildOptions.fontOverrides */
  overridden: boolean;
  /** Number of runs using it */
  runs: number;
}

export interface BuildResult {
  /** The .pptx file. */
  data: Uint8Array;
  /** Fonts the recipient must have installed. */
  fonts: FontReportItem[];
  /** Build-phase report entries (slide scaled, size mismatch, dropped features…). */
  report: ReportEntry[];
  /** Counters for tests / UI summary. */
  stats: { slides: number; texts: number; shapes: number; images: number; groups: number };
}

export type BuildPptx = (
  deck: import('../ir/types').Deck,
  options: BuildOptions,
  onProgress?: (p: BuildProgress) => void,
) => Promise<BuildResult>;
