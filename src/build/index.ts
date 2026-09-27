/**
 * IR → PPTX builder (Node + browser): pptxgenjs writes the package skeleton, post/ patches the OOXML.
 *
 *   layout (one slide size — the first slide's or `options.slideSize` — per-slide scale + centering)
 *   → pptxgenjs objects named `fd:<n>` + manifest
 *   → pres.write() → postProcess(manifest) → .pptx bytes
 */
import PptxGenJS from 'pptxgenjs';
import { CONFIG } from '../config';
import type { Deck, ReportEntry, Slide } from '../ir/types';
import { postProcess } from '../post';
import type { BuildOptions, BuildPptx, BuildProgress, BuildResult } from './api';
import { alphaToTransparency, effectiveAlpha, hexColor } from './color';
import { SlideContext, type BuildStats, type DeckState } from './context';
import { emitElements } from './emit';
import { FontTracker } from './fonts';
import { computeDeckLayout, type DeckLayout } from './layout';
import type { BuildManifest, PackageMeta } from './manifest';
import { stripInvalidXmlChars } from './xml';

const LAYOUT_NAME = 'FIGMADECK';

/** ISO 8601 without milliseconds, as Office writes it. */
function isoTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const v of values) if (typeof v === 'string' && v.trim() !== '') return v;
  return '';
}

/** Document metadata: options → deck.meta → CONFIG.meta. Never the pptxgenjs defaults. */
export function resolveMeta(deck: Deck, options: BuildOptions): PackageMeta {
  return {
    title: firstNonEmpty(options.title, deck.meta?.title, deck.slides[0]?.name),
    subject: firstNonEmpty(options.subject, deck.meta?.subject),
    author: firstNonEmpty(options.author, deck.meta?.author, CONFIG.meta.defaultAuthor),
    company: firstNonEmpty(options.company, deck.meta?.company, CONFIG.meta.defaultCompany),
    application: CONFIG.meta.application,
    timestamp: isoTimestamp(options.now ?? new Date()),
  };
}

/** Yield to the event loop between slides (keeps the UI responsive); works without DOM / Node typings. */
function yieldToEventLoop(): Promise<void> {
  const g = globalThis as unknown as { setTimeout?: (cb: () => void, ms: number) => unknown };
  return new Promise((resolve) => (g.setTimeout ? g.setTimeout(resolve, 0) : resolve()));
}

/** Percent with one decimal, e.g. `80.8%`. */
function percent(scale: number): string {
  return `${(scale * 100).toFixed(1)}%`;
}

/** Inches with up to three decimals, e.g. `34.575`. */
function inches(pt: number): string {
  return String(Number((pt / CONFIG.units.pxPerInch).toFixed(3)));
}

/** Offsets (pt) below this count as "no letterbox". */
const LETTERBOX_EPSILON_PT = 0.01;

/**
 * `slide-scaled` entries:
 * - fixed slide size (`BuildOptions.slideSize`): `info` for every slide whose scale ≠ 1;
 * - otherwise: `warning` for slides whose size differs from the first one (fitted into its size),
 *   `info` for slides scaled into PowerPoint's 1″…56″ range.
 */
function layoutReport(deck: Deck, layout: DeckLayout): ReportEntry[] {
  const first = deck.slides[0];
  const entries: ReportEntry[] = [];
  deck.slides.forEach((s: Slide, i) => {
    const p = layout.placements[i];
    const scaled = Math.abs(p.scale - 1) > 1e-9;
    const base = { code: 'slide-scaled', slideId: s.id, slideName: s.name };
    if (layout.fixed) {
      if (!scaled) return;
      const letterboxed = p.offsetX > LETTERBOX_EPSILON_PT || p.offsetY > LETTERBOX_EPSILON_PT;
      const size = `${inches(layout.widthPt)}×${inches(layout.heightPt)} in`;
      entries.push({
        ...base,
        level: 'info',
        message:
          `Slide (${s.width}×${s.height} px) scaled to ${percent(p.scale)} to fit the ${size} slide size` +
          (letterboxed ? ' and centered; the margins show the slide background.' : '.') +
          ' Font sizes and spacing were scaled too.',
      });
      return;
    }
    if (!p.sizeDiffers && !scaled) return;
    const message = p.sizeDiffers
      ? `Slide is ${s.width}×${s.height} px but the presentation uses the first slide's size (${first.width}×${first.height} px); it was scaled to ${percent(p.scale)} and centered.`
      : `Slide scaled to ${percent(p.scale)} to fit PowerPoint's slide size limits (1–${CONFIG.slide.maxInches} in per side); font sizes and spacing were scaled too.`;
    entries.push({ ...base, level: p.sizeDiffers ? 'warning' : 'info', message });
  });
  return entries;
}

function toBytes(out: unknown): Uint8Array {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  throw new Error('buildPptx: pptxgenjs returned an unexpected output type');
}

export const buildPptx: BuildPptx = async (deck, options, onProgress) => {
  if (!deck.slides || deck.slides.length === 0) throw new Error('buildPptx: the deck has no slides');
  const progress = (p: BuildProgress) => onProgress?.(p);
  const layout = computeDeckLayout(deck.slides, options.slideSize);
  const meta = resolveMeta(deck, options);

  const pres = new PptxGenJS();
  pres.defineLayout({ name: LAYOUT_NAME, width: layout.widthPt / CONFIG.units.pxPerInch, height: layout.heightPt / CONFIG.units.pxPerInch });
  pres.layout = LAYOUT_NAME;
  pres.title = meta.title;
  pres.subject = meta.subject;
  pres.author = meta.author;
  pres.company = meta.company;

  const stats: BuildStats = { slides: 0, texts: 0, shapes: 0, images: 0, groups: 0 };
  const state: DeckState = {
    deck,
    options,
    fonts: new FontTracker(options.fontOverrides ?? {}, options.fontNaming),
    report: layoutReport(deck, layout),
    stats,
    slideNumbers: new Map(deck.slides.map((s, i) => [s.id, i + 1] as const)),
    svgAssets: {},
    dataUrls: new Map(),
    nextObjectId: 1,
  };
  const manifest: BuildManifest = { slides: [], svgAssets: state.svgAssets, meta };

  const total = deck.slides.length;
  for (let i = 0; i < total; i++) {
    const slide = deck.slides[i];
    const pptSlide = pres.addSlide();
    if (slide.background) {
      const alpha = effectiveAlpha(slide.background.color, 1);
      pptSlide.background = { color: hexColor(slide.background.color), transparency: alphaToTransparency(alpha) };
    }
    const ctx = new SlideContext(state, slide, i + 1, layout.placements[i], pptSlide);
    emitElements(ctx, slide.elements ?? []);
    if (slide.notes) pptSlide.addNotes(stripInvalidXmlChars(slide.notes));
    manifest.slides.push(ctx.manifest);
    stats.slides++;
    progress({ phase: 'slides', done: i + 1, total });
    await yieldToEventLoop();
  }

  progress({ phase: 'package', done: 0, total: 1 });
  const raw = toBytes(await pres.write({ outputType: 'uint8array' }));
  progress({ phase: 'package', done: 1, total: 1 });

  const post = await postProcess(raw, manifest, (done, n) => progress({ phase: 'post', done, total: n }));
  for (const w of post.warnings) {
    const s = deck.slides[w.slideNumber - 1];
    state.report.push({ level: 'warning', code: 'group-flattened', slideId: s?.id ?? '', slideName: s?.name ?? '', message: w.message });
  }

  const result: BuildResult = {
    data: post.data,
    fonts: state.fonts.report(),
    report: state.report,
    stats: { ...stats },
  };
  return result;
};
