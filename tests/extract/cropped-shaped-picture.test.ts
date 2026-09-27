/**
 * Image-fill pictures with an ELLIPSE / ROUNDRECT geometry (or a shadow) are never cropped: a crop
 * would draw the ellipse / rounded corners / shadow on the CROPPED box. Cut by a clipping frame they
 * are rasterized ('clip'); cut only by the slide edge they stay native and whole (PowerPoint clips at
 * the slide edge itself). Plain rectangular pictures keep being cropped.
 */
import { beforeEach, expect, it } from 'vitest';
import type { ImageElement } from '../../src/ir/types';
import { FakeEnv, ellipse, frame, imagePaint, innerShadow, makePng, rect, resetIds } from '../helpers/figma-mocks';
import { flat, run } from './helpers';

beforeEach(() => resetIds());

it('avatar circle half outside the slide keeps its circular shape (native, uncropped)', async () => {
  const env = new FakeEnv();
  env.addImage('face', makePng(200, 200), 200, 200);
  const root = frame({ id: 'root', width: 800, height: 600, children: [ellipse({ id: 'avatar', x: -50, y: 100, width: 100, height: 100, fills: [imagePaint('face')] })] });
  const { slide } = await run(root, {}, env);
  const pic = slide.elements.find((e) => e.id === 'avatar') as ImageElement;
  expect(pic).toMatchObject({ geometry: 'ellipse', crop: null, transform: { x: -50, y: 100, w: 100, h: 100 } });
  expect(pic.rasterized).toBeUndefined();
});

it('rounded image cut by a clipping frame is rasterized, not rounded on the cut edge', async () => {
  const env = new FakeEnv();
  env.addImage('photo', makePng(400, 200), 400, 200);
  const carousel = frame({
    id: 'carousel', x: 100, y: 100, width: 300, height: 200,
    children: [rect({ id: 'slideImg', x: 200, y: 0, width: 200, height: 200, cornerRadius: 24, fills: [imagePaint('photo')] })],
  });
  const { slide, report } = await run(frame({ width: 800, height: 600, children: [carousel] }), { preserveGroups: false }, env);
  const pic = flat(slide.elements).find((e) => e.id === 'slideImg') as ImageElement;
  expect(pic.rasterized?.reasons).toEqual(['clip']);
  expect(pic.geometry).toBe('rect');
  // Placed at Figma's (clipped) render bounds: slide x 300..400.
  expect(pic.transform).toMatchObject({ x: 300, y: 100, w: 100, h: 200 });
  expect(report.find((r) => r.nodeId === 'slideImg')?.reasons).toEqual(['clip']);
});

it('ellipse image cut by a clipping frame is rasterized', async () => {
  const env = new FakeEnv();
  env.addImage('face', makePng(200, 200), 200, 200);
  const panel = frame({ id: 'panel', x: 100, y: 100, width: 200, height: 200, children: [ellipse({ id: 'avatar', x: 150, y: 50, width: 100, height: 100, fills: [imagePaint('face')] })] });
  const { slide } = await run(frame({ width: 800, height: 600, children: [panel] }), { preserveGroups: false }, env);
  const pic = flat(slide.elements).find((e) => e.id === 'avatar') as ImageElement;
  expect(pic.rasterized?.reasons).toEqual(['clip']);
});

it('rounded image cut only by the slide edge stays a native rounded picture, uncropped', async () => {
  const env = new FakeEnv();
  env.addImage('photo', makePng(400, 200), 400, 200);
  const root = frame({ width: 800, height: 600, children: [rect({ id: 'img', x: 700, y: 100, width: 200, height: 100, cornerRadius: 12, fills: [imagePaint('photo')] })] });
  const { slide } = await run(root, {}, env);
  const pic = slide.elements[0] as ImageElement;
  expect(pic).toMatchObject({ id: 'img', geometry: 'roundRect', cornerRadius: 12, crop: null, transform: { x: 700, w: 200 } });
});

it('picture with an inner shadow cut by a clipping frame is rasterized; plain pictures are still cropped', async () => {
  const env = new FakeEnv();
  env.addImage('photo', makePng(400, 200), 400, 200);
  const panel = frame({
    id: 'panel', x: 100, y: 100, width: 200, height: 200,
    children: [
      rect({ id: 'shadowed', x: 100, y: 0, width: 200, height: 100, fills: [imagePaint('photo')], effects: [innerShadow()] }),
      rect({ id: 'plain', x: 100, y: 100, width: 200, height: 100, fills: [imagePaint('photo')] }),
    ],
  });
  const { slide } = await run(frame({ width: 800, height: 600, children: [panel] }), { preserveGroups: false }, env);
  const els = flat(slide.elements);
  expect((els.find((e) => e.id === 'shadowed') as ImageElement).rasterized?.reasons).toEqual(['clip']);
  const plain = els.find((e) => e.id === 'plain') as ImageElement;
  expect(plain.rasterized).toBeUndefined();
  expect(plain.transform).toMatchObject({ x: 200, y: 200, w: 100, h: 100 });
  expect(plain.crop).toMatchObject({ right: 0.5 });
});
