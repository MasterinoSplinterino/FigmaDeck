/**
 * One frame → one IR slide, in the three export modes:
 * - editable: walker plan (native text / shapes / images / groups, per-layer rasters);
 * - exact: one background picture of the frame with the native texts hidden (temporary composite),
 *   native text boxes on top;
 * - image: one picture of the frame (PNG at the raster scale; the UI may re-encode it).
 * Slide pictures cover the frame's bounding box (`useAbsoluteBounds`), placed at its origin with size
 * bitmap px / scale; they are not cropped (PowerPoint clips at the slide edge).
 */
import { CONFIG } from '../config';
import type { Element, ReportEntry, Slide, TextElement } from '../ir/types';
import type { ExportSettings } from '../shared/settings';
import type { AssetStore } from './assets';
import type { FigmaEnv } from './figma-env';
import { invert } from './geometry';
import type { MeasureLineHeight } from './line-height';
import { absoluteTransformOf, clipsContentOf, sizeOf } from './node-props';
import { executePlan, type IdRegistry } from './plan';
import { throwIfCancelled, type CancelCheck } from './pool';
import { exportComposite, exportPicture, type ExportedPicture, type RasterContext, type TempNodes } from './raster';
import { nodeRef, SlideReport } from './report';
import { pictureElement, slideBackground, SlideWalker, type ImageCache, type SlideContext } from './walker';

export interface SlideExtractOptions {
  env: FigmaEnv;
  settings: ExportSettings;
  assets: AssetStore;
  temp: TempNodes;
  images: ImageCache;
  ids: IdRegistry;
  isCancelled?: CancelCheck;
  /** Progress: layers visited so far on this slide. */
  onVisit?: (visited: number) => void;
  /** Progress: export jobs finished on this slide. */
  onJobDone?: (done: number, total: number) => void;
  /** AUTO line-height measurement (line-height.ts); absent = AUTO stays in the IR. */
  measureLineHeight?: MeasureLineHeight;
}

export interface SlideExtractResult {
  slide: Slide;
  report: ReportEntry[];
}

/** Opacity for a picture of the root frame (its own opacity is in the bitmap unless configured otherwise). */
function rootPictureOpacity(frame: SceneNode): number {
  const own = 'opacity' in frame && typeof frame.opacity === 'number' ? frame.opacity : 1;
  return CONFIG.extract.exportIncludesOwnOpacity ? 1 : own;
}

export async function extractSlide(frame: SceneNode, opts: SlideExtractOptions): Promise<SlideExtractResult> {
  const { width, height } = sizeOf(frame);
  const report = new SlideReport(frame.id, frame.name);
  const slideInverse = invert(absoluteTransformOf(frame));
  const ctx: SlideContext = {
    env: opts.env,
    settings: opts.settings,
    frame,
    slideInverse,
    slideRect: { x: 0, y: 0, w: width, h: height },
    rootClips: clipsContentOf(frame),
    assets: opts.assets,
    temp: opts.temp,
    report,
    images: opts.images,
    isCancelled: opts.isCancelled,
    onVisit: opts.onVisit,
    visited: 0,
    measureLineHeight: opts.measureLineHeight,
  };
  const raster: RasterContext = { env: opts.env, settings: opts.settings, assets: opts.assets, temp: opts.temp };
  const background = slideBackground(frame, opts.env.mixed);
  let elements: Element[];

  throwIfCancelled(opts.isCancelled);
  switch (opts.settings.mode) {
    case 'image': {
      const picture = await exportPicture(raster, frame, { role: 'background', useAbsoluteBounds: true });
      const el = picture
        ? pictureElement(ctx, { id: `~image:${frame.id}`, name: frame.name }, picture, rootPictureOpacity(frame), ['image-mode'], null)
        : null;
      if (el) report.rasterized(nodeRef(frame), ['image-mode']);
      elements = el ? [el] : [];
      break;
    }
    case 'exact': {
      const walker = new SlideWalker(ctx);
      const texts = await walker.collectExactTexts();
      throwIfCancelled(opts.isCancelled);
      let keptTexts: TextElement[] = texts.map((t) => t.element);
      let picture: ExportedPicture | null;
      if (texts.length === 0) {
        picture = await exportPicture(raster, frame, { role: 'background', useAbsoluteBounds: true });
      } else {
        const composite = await exportComposite(
          raster,
          { ancestor: frame, keep: null, hide: texts.map((t) => t.path), useAbsoluteBounds: true },
          'background',
        );
        picture = composite;
        if (composite) {
          // A text that could not be hidden in the clone stays in the background only (no double text).
          keptTexts = texts.filter((_, i) => composite.hidden[i]).map((t) => t.element);
          texts.forEach((t, i) => {
            if (!composite.hidden[i]) report.info('exact-text-in-background', `"${t.element.name}" stays in the background picture.`);
          });
        }
      }
      const bg = picture
        ? pictureElement(ctx, { id: `~exact:${frame.id}`, name: frame.name }, picture, rootPictureOpacity(frame), ['exact-mode'], null)
        : null;
      if (bg) report.rasterized(nodeRef(frame), ['exact-mode']);
      elements = bg ? [bg, ...keptTexts] : keptTexts;
      break;
    }
    default: {
      const walker = new SlideWalker(ctx);
      const { plans } = await walker.planRoot();
      elements = await executePlan(plans, {
        concurrency: CONFIG.export.exportConcurrency,
        preserveGroups: opts.settings.preserveGroups,
        isCancelled: opts.isCancelled,
        onJobDone: opts.onJobDone,
      });
    }
  }
  opts.ids.apply(elements);
  return {
    slide: { id: frame.id, name: frame.name, width, height, background, elements },
    report: report.entries,
  };
}
