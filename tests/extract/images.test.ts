import { describe, expect, it } from 'vitest';
import { computeImageCrop, cropFromImageTransform, cropPictureToRect, imagePaintReasons, subRectTransform } from '../../src/extract/images';
import type { Transform } from '../../src/ir/types';
import { imagePaint } from '../helpers/figma-mocks';

const t = (x: number, y: number, w: number, h: number, extra: Partial<Transform> = {}): Transform => ({
  x,
  y,
  w,
  h,
  rotation: 0,
  flipH: false,
  flipV: false,
  ...extra,
});

describe('computeImageCrop', () => {
  it('FILL: cover crop, centered', () => {
    // 400×200 image in a 100×100 box: scale 0.5 → 200×100 displayed, 50 % of the width cut, 25 % per side.
    expect(computeImageCrop('FILL', 100, 100, 400, 200)).toEqual({
      crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 },
      box: { x: 0, y: 0, w: 100, h: 100 },
      displayWidth: 200,
      displayHeight: 100,
    });
    // Same aspect → no crop.
    expect(computeImageCrop('FILL', 100, 50, 200, 100)?.crop).toBeNull();
  });

  it('FIT: contain, centered sub-rectangle, no crop', () => {
    expect(computeImageCrop('FIT', 100, 100, 400, 200)).toEqual({
      crop: null,
      box: { x: 0, y: 25, w: 100, h: 50 },
      displayWidth: 100,
      displayHeight: 50,
    });
  });

  it('CROP: imageTransform maps the layer into image space', () => {
    const r = computeImageCrop('CROP', 100, 50, 1000, 1000, [
      [0.5, 0, 0.25],
      [0, 0.25, 0.1],
    ]);
    expect(r).toEqual({
      crop: { left: 0.25, top: 0.1, right: 0.25, bottom: 0.65 },
      box: { x: 0, y: 0, w: 100, h: 50 },
      displayWidth: 200,
      displayHeight: 200,
    });
  });

  it('CROP: the transform verified in Figma — [[0.5,0,0.25],[0,0.5,0.1]] shows u 0.25..0.75, v 0.1..0.6', () => {
    expect(
      computeImageCrop('CROP', 100, 100, 1000, 1000, [
        [0.5, 0, 0.25],
        [0, 0.5, 0.1],
      ]),
    ).toEqual({
      crop: { left: 0.25, top: 0.1, right: 0.25, bottom: 0.4 },
      box: { x: 0, y: 0, w: 100, h: 100 },
      displayWidth: 200,
      displayHeight: 200,
    });
  });

  it('CROP without rotation/skew and inside the image only', () => {
    expect(cropFromImageTransform([[0.5, 0.1, 0], [0, 0.5, 0]])).toBeNull();
    expect(cropFromImageTransform([[0.5, 0, 0.6], [0, 0.5, 0]])).toBeNull(); // right edge beyond the image
    expect(cropFromImageTransform([[-0.5, 0, 1], [0, 0.5, 0]])).toBeNull(); // mirrored
    expect(cropFromImageTransform(undefined)?.crop).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('TILE / empty sizes → null', () => {
    expect(computeImageCrop('TILE', 100, 100, 10, 10)).toBeNull();
    expect(computeImageCrop('FILL', 0, 100, 10, 10)).toBeNull();
  });
});

describe('imagePaintReasons', () => {
  it('flags modes, rotation, filters, blend', () => {
    expect(imagePaintReasons(imagePaint('h') as ImagePaint)).toEqual([]);
    expect(imagePaintReasons(imagePaint('h', 'TILE') as ImagePaint)).toEqual(['image-fill-mode']);
    expect(imagePaintReasons(imagePaint('h', 'FILL', { rotation: 90 }) as ImagePaint)).toEqual(['image-fill-mode']);
    expect(imagePaintReasons(imagePaint('h', 'FILL', { rotation: 360 }) as ImagePaint)).toEqual([]);
    expect(imagePaintReasons(imagePaint('h', 'FILL', { filters: { exposure: 0, contrast: 0.2 } }) as ImagePaint)).toEqual(['image-filters']);
    expect(imagePaintReasons(imagePaint('h', 'FILL', { filters: { exposure: 0 } }) as ImagePaint)).toEqual([]);
    expect(imagePaintReasons(imagePaint('h', 'FILL', { blendMode: 'MULTIPLY' }) as ImagePaint)).toEqual(['blend-mode']);
    expect(imagePaintReasons(imagePaint('h', 'CROP', { imageTransform: [[1, 0.2, 0], [0, 1, 0]] }) as ImagePaint)).toEqual(['image-fill-mode']);
  });
});

describe('cropPictureToRect', () => {
  it('shrinks the box and extends the crop', () => {
    const r = cropPictureToRect(t(0, 0, 100, 100), { left: 0.2, right: 0.2, top: 0, bottom: 0 }, { x: 50, y: -10, w: 100, h: 60 });
    // Visible x 50..100, y 0..50. Source width 0.6: left += 0.5 × 0.6.
    expect(r?.transform).toEqual(t(50, 0, 50, 50));
    expect(r?.crop).toEqual({ left: 0.5, right: 0.2, top: 0, bottom: 0.5 });
  });

  it('flips swap the cut sides', () => {
    const r = cropPictureToRect(t(0, 0, 100, 100, { flipH: true }), null, { x: 0, y: 0, w: 25, h: 100 });
    expect(r?.crop).toEqual({ left: 0.75, right: 0, top: 0, bottom: 0 });
  });

  it('rotated or fully clipped → null', () => {
    expect(cropPictureToRect(t(0, 0, 10, 10, { rotation: 90 }), null, { x: 0, y: 0, w: 5, h: 5 })).toBeNull();
    expect(cropPictureToRect(t(0, 0, 10, 10), null, { x: 20, y: 0, w: 5, h: 5 })).toBeNull();
  });
});

describe('subRectTransform', () => {
  it('keeps a centered sub-rect centered on rotated layers', () => {
    const layer = t(0, 0, 100, 100, { rotation: 90 });
    expect(subRectTransform(layer, { x: 0, y: 25, w: 100, h: 50 })).toEqual(t(0, 25, 100, 50, { rotation: 90 }));
  });

  it('off-center sub-rects follow the rotation', () => {
    const layer = t(0, 0, 100, 100, { rotation: 90 });
    // Sub-rect in the top-left quarter; after a 90° clockwise turn it sits top-right.
    expect(subRectTransform(layer, { x: 0, y: 0, w: 50, h: 50 })).toEqual(t(50, 0, 50, 50, { rotation: 90 }));
  });
});
