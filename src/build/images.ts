/**
 * IR images → pictures (`<p:pic>`).
 *
 * pptxgenjs writes the picture with its media part: crop via `sizing: {type: 'crop'}` (→ `<a:srcRect>`),
 * opacity via `transparency` (→ `<a:alphaModFix>`), ellipse clip via `rounding`, alt text via `altText`.
 * post/ adds the roundRect clip (`adj`), the SVG blip (`asvg:svgBlip`) and shadows.
 * SVG is never passed to pptxgenjs (its SVG path needs a browser canvas for the PNG fallback).
 */
import type PptxGenJS from 'pptxgenjs';
import type { Crop, ImageElement } from '../ir/types';
import { bytesToBase64 } from '../ir/serialize';
import { alphaToTransparency } from './color';
import { rotatedBounds, type SlideContext } from './context';
import { shadowEffectXml } from './effects';
import { roundRectGeometryXml } from './shapes';
import { emuArg } from './units';

/** A crop is usable when every side is finite and the visible part is non-empty. Negative = padding. */
export function validCrop(crop: Crop | null | undefined): crop is Crop {
  if (!crop) return false;
  const { left, top, right, bottom } = crop;
  if (![left, top, right, bottom].every(Number.isFinite)) return false;
  return left + right < 1 && top + bottom < 1;
}

function isIdentityCrop(c: Crop): boolean {
  return c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0;
}

/** `image/png;base64,…` (pptxgenjs format, no `data:` prefix), cached per asset. */
function dataUrl(ctx: SlideContext, assetId: string, mime: string, data: Uint8Array): string {
  const cache = ctx.state.dataUrls;
  let url = cache.get(assetId);
  if (url === undefined) {
    url = `${mime};base64,${bytesToBase64(data)}`;
    cache.set(assetId, url);
  }
  return url;
}

/** Emit an image element; returns the object names written (empty when the asset is unusable). */
export function emitImage(ctx: SlideContext, el: ImageElement): string[] {
  const asset = ctx.state.deck.assets[el.assetId];
  if (!asset || !asset.data || asset.data.length === 0) {
    ctx.addReport('warning', 'missing-asset', `Image asset "${el.assetId}" is missing; the layer was skipped.`, el.id, el.name);
    return [];
  }
  if (asset.mime === 'image/svg+xml') {
    ctx.addReport('warning', 'unsupported-asset', `Image asset "${el.assetId}" is SVG without a raster fallback; the layer was skipped.`, el.id, el.name);
    return [];
  }

  const link = ctx.linkIndex(el.hyperlink, el.id, el.name);
  const name = ctx.nextName();
  const t = el.transform;
  const box = ctx.transformEmu(t);
  const opts: PptxGenJS.ImageProps = {
    data: dataUrl(ctx, asset.id || el.assetId, asset.mime, asset.data),
    objectName: name,
    altText: el.name,
    x: emuArg(box.x),
    y: emuArg(box.y),
    w: emuArg(Math.max(1, box.w)),
    h: emuArg(Math.max(1, box.h)),
  };

  if (el.crop && !isIdentityCrop(el.crop)) {
    if (validCrop(el.crop) && box.w > 0 && box.h > 0) {
      // pptxgenjs crop: options w/h = full display size of the source, sizing = visible window in it.
      const c = el.crop;
      const fullW = box.w / (1 - c.left - c.right);
      const fullH = box.h / (1 - c.top - c.bottom);
      opts.w = emuArg(fullW);
      opts.h = emuArg(fullH);
      opts.sizing = { type: 'crop', x: emuArg(c.left * fullW), y: emuArg(c.top * fullH), w: emuArg(box.w), h: emuArg(box.h) };
    } else {
      ctx.addReport('warning', 'invalid-crop', 'Image crop is invalid and was ignored.', el.id, el.name);
    }
  }
  if (el.opacity < 1) opts.transparency = alphaToTransparency(Math.max(0, el.opacity));
  if (el.geometry === 'ellipse') opts.rounding = true;
  if (t.rotation) opts.rotate = t.rotation;
  if (t.flipH) opts.flipH = true;
  if (t.flipV) opts.flipV = true;

  ctx.pptSlide.addImage(opts);

  let svgAssetId: string | null = null;
  if (el.svgAssetId && ctx.options.svgVectors) {
    const svg = ctx.state.deck.assets[el.svgAssetId];
    if (svg && svg.mime === 'image/svg+xml' && svg.data.length > 0) {
      svgAssetId = el.svgAssetId;
      ctx.state.svgAssets[el.svgAssetId] = svg.data;
    } else {
      ctx.addReport('info', 'missing-asset', `SVG asset "${el.svgAssetId}" is missing; only the PNG fallback was written.`, el.id, el.name);
    }
  }

  ctx.addObject({
    kind: 'image',
    name,
    layerName: el.name,
    bounds: rotatedBounds(box, t.rotation),
    link,
    effectLst: el.shadow ? shadowEffectXml(el.shadow, ctx.scale, el.opacity) : null,
    geometry: el.geometry === 'roundRect' ? roundRectGeometryXml(el.cornerRadius || 0, t.w, t.h) : null,
    svgAssetId,
  });
  ctx.state.stats.images++;
  return [name];
}
