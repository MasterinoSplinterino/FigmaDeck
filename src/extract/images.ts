/**
 * IMAGE fills → picture placement + OOXML crop (pure math), and clip cropping of pictures.
 *
 * Figma semantics (verified: the CROP `imageTransform` maps the LAYER's unit square into the IMAGE's
 * unit square — [[0.5, 0, 0.25], [0, 0.5, 0.25]] shows the centered half of the image — the same
 * direction as `gradientTransform`):
 * - FILL: cover — scaled by max(w/iw, h/ih), centered, overflow cut.
 * - FIT: contain — scaled by min(w/iw, h/ih), centered, the rest of the layer transparent.
 * - CROP: visible image region u ∈ [tx, tx + a], v ∈ [ty, ty + d] (no rotation / skew allowed).
 * - TILE, `rotation` ≠ 0, image filters → not native.
 */
import { CONFIG } from '../config';
import type { Crop, RasterReason, Rect, Transform } from '../ir/types';
import { clean } from './geometry';
import { isNormalBlend } from './paints';

export interface ImagePlacement {
  /** Crop of the source image, `null` = none. */
  crop: Crop | null;
  /** Region of the layer box covered by the picture, layer-local px (FIT: centered sub-rect). */
  box: Rect;
  /** Size (px) at which the WHOLE (uncropped) image is displayed. */
  displayWidth: number;
  displayHeight: number;
}

/** Reasons an IMAGE paint cannot become a native picture (empty = it can). */
export function imagePaintReasons(paint: ImagePaint): RasterReason[] {
  const reasons: RasterReason[] = [];
  if (!isNormalBlend(paint.blendMode)) reasons.push('blend-mode');
  if (paint.scaleMode === 'TILE') reasons.push('image-fill-mode');
  const rotation = (((paint.rotation ?? 0) % 360) + 360) % 360;
  if (rotation !== 0 && !reasons.includes('image-fill-mode')) reasons.push('image-fill-mode');
  if (paint.scaleMode === 'CROP' && !cropFromImageTransform(paint.imageTransform) && !reasons.includes('image-fill-mode')) {
    reasons.push('image-fill-mode');
  }
  const f = paint.filters;
  if (f && Object.values(f).some((v) => typeof v === 'number' && Math.abs(v) > 1e-6)) reasons.push('image-filters');
  return reasons;
}

function cleanCrop(c: Crop): Crop | null {
  const eps = CONFIG.extract.cropEpsilon;
  const v = (x: number) => (Math.abs(x) < eps ? 0 : clean(x));
  const out = { left: v(c.left), top: v(c.top), right: v(c.right), bottom: v(c.bottom) };
  return out.left === 0 && out.top === 0 && out.right === 0 && out.bottom === 0 ? null : out;
}

/**
 * CROP `imageTransform` → crop fractions, or `null` when it rotates / skews / flips the image or shows
 * area outside the image (not representable as a plain `<a:srcRect>`).
 */
export function cropFromImageTransform(t: Transform2x3 | undefined): { crop: Crop; scaleX: number; scaleY: number } | null {
  if (!t) return { crop: { left: 0, top: 0, right: 0, bottom: 0 }, scaleX: 1, scaleY: 1 };
  const [[a, c, tx], [b, d, ty]] = t;
  const eps = CONFIG.extract.cropEpsilon;
  if (Math.abs(b) > eps || Math.abs(c) > eps || !(a > eps) || !(d > eps)) return null;
  const crop = { left: tx, top: ty, right: 1 - tx - a, bottom: 1 - ty - d };
  if (crop.left < -eps || crop.top < -eps || crop.right < -eps || crop.bottom < -eps) return null;
  return {
    crop: {
      left: Math.max(0, crop.left),
      top: Math.max(0, crop.top),
      right: Math.max(0, crop.right),
      bottom: Math.max(0, crop.bottom),
    },
    scaleX: a,
    scaleY: d,
  };
}

type Transform2x3 = readonly [readonly [number, number, number], readonly [number, number, number]];

/**
 * Placement of an image of `imageW × imageH` px in a `boxW × boxH` layer. `null` when the scale mode
 * is not representable (TILE, bad CROP transform, empty sizes).
 */
export function computeImageCrop(
  scaleMode: ImagePaint['scaleMode'],
  boxW: number,
  boxH: number,
  imageW: number,
  imageH: number,
  imageTransform?: Transform2x3,
): ImagePlacement | null {
  if (!(boxW > 0 && boxH > 0 && imageW > 0 && imageH > 0)) return null;
  const full: Rect = { x: 0, y: 0, w: boxW, h: boxH };
  switch (scaleMode) {
    case 'FILL': {
      const s = Math.max(boxW / imageW, boxH / imageH);
      const dw = imageW * s;
      const dh = imageH * s;
      const lr = (1 - boxW / dw) / 2;
      const tb = (1 - boxH / dh) / 2;
      return {
        crop: cleanCrop({ left: lr, right: lr, top: tb, bottom: tb }),
        box: full,
        displayWidth: clean(dw),
        displayHeight: clean(dh),
      };
    }
    case 'FIT': {
      const s = Math.min(boxW / imageW, boxH / imageH);
      const dw = imageW * s;
      const dh = imageH * s;
      return {
        crop: null,
        box: { x: clean((boxW - dw) / 2), y: clean((boxH - dh) / 2), w: clean(dw), h: clean(dh) },
        displayWidth: clean(dw),
        displayHeight: clean(dh),
      };
    }
    case 'CROP': {
      const r = cropFromImageTransform(imageTransform);
      if (!r) return null;
      return {
        crop: cleanCrop(r.crop),
        box: full,
        displayWidth: clean(boxW / r.scaleX),
        displayHeight: clean(boxH / r.scaleY),
      };
    }
    default:
      return null;
  }
}

/**
 * Shrink an UNROTATED picture to the part inside `visible` (slide px) and extend its crop accordingly.
 * Flips mirror the source, so the cut sides swap. Returns `null` when the picture is rotated (caller
 * rasterizes with the clip instead) or nothing remains.
 */
export function cropPictureToRect(
  t: Transform,
  crop: Crop | null,
  visible: Rect,
): { transform: Transform; crop: Crop | null } | null {
  if (t.rotation !== 0) return null;
  const x0 = Math.max(t.x, visible.x);
  const y0 = Math.max(t.y, visible.y);
  const x1 = Math.min(t.x + t.w, visible.x + visible.w);
  const y1 = Math.min(t.y + t.h, visible.y + visible.h);
  if (x1 <= x0 || y1 <= y0 || t.w <= 0 || t.h <= 0) return null;
  const c = crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  let cutL = (x0 - t.x) / t.w;
  let cutR = (t.x + t.w - x1) / t.w;
  let cutT = (y0 - t.y) / t.h;
  let cutB = (t.y + t.h - y1) / t.h;
  if (t.flipH) [cutL, cutR] = [cutR, cutL];
  if (t.flipV) [cutT, cutB] = [cutB, cutT];
  const srcW = 1 - c.left - c.right;
  const srcH = 1 - c.top - c.bottom;
  return {
    transform: { ...t, x: clean(x0), y: clean(y0), w: clean(x1 - x0), h: clean(y1 - y0) },
    crop: cleanCrop({
      left: c.left + cutL * srcW,
      right: c.right + cutR * srcW,
      top: c.top + cutT * srcH,
      bottom: c.bottom + cutB * srcH,
    }),
  };
}

/**
 * Placement of a layer-local sub-rectangle (FIT) given the layer's transform: the sub-rect keeps the
 * layer's rotation / flip and its center moves with the layer.
 */
export function subRectTransform(layer: Transform, box: Rect): Transform {
  if (box.x === 0 && box.y === 0 && box.w === layer.w && box.h === layer.h) return layer;
  // Offset of the sub-rect center from the layer center, in layer-local axes.
  let dx = box.x + box.w / 2 - layer.w / 2;
  let dy = box.y + box.h / 2 - layer.h / 2;
  if (layer.flipH) dx = -dx;
  if (layer.flipV) dy = -dy;
  const rad = (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = layer.x + layer.w / 2 + dx * cos - dy * sin;
  const cy = layer.y + layer.h / 2 + dx * sin + dy * cos;
  return { ...layer, x: clean(cx - box.w / 2), y: clean(cy - box.h / 2), w: clean(box.w), h: clean(box.h) };
}
