/**
 * The shadow of a NATIVE picture must not survive a clip that cuts it: Figma clips the shadow at the
 * clipping frame, PowerPoint would draw it whole. Such pictures are rasterized ('clip'), like shapes.
 */
import { beforeEach, expect, it } from 'vitest';
import type { ImageElement } from '../../src/ir/types';
import { FakeEnv, dropShadow, frame, imagePaint, innerShadow, makePng, rect, resetIds, solid } from '../helpers/figma-mocks';
import { flat, run } from './helpers';

beforeEach(() => resetIds());

it('card-cover image with an outer shadow inside a rounded clipping card → composite with the card', async () => {
  const env = new FakeEnv();
  env.addImage('cover', makePng(400, 200), 400, 200);
  const card = frame({
    id: 'card', x: 50, y: 50, width: 200, height: 100, cornerRadius: 16,
    children: [rect({ id: 'photo', width: 200, height: 100, fills: [imagePaint('cover')], effects: [dropShadow()] })],
  });
  const { slide } = await run(frame({ width: 800, height: 600, children: [card] }), {}, env);
  const els = flat(slide.elements);
  expect(els.find((e) => e.id === 'photo')).toBeUndefined();
  const pic = els.find((e) => e.id === '~clip:photo') as ImageElement;
  expect(pic.shadow).toBeNull();
  expect(pic.rasterized?.reasons).toEqual(['clip']);
});

it('card-cover image without an outer shadow stays a native rounded picture (inner shadow kept)', async () => {
  const env = new FakeEnv();
  env.addImage('cover', makePng(400, 200), 400, 200);
  const card = frame({
    id: 'card', x: 50, y: 50, width: 200, height: 100, cornerRadius: 16,
    children: [rect({ id: 'photo', width: 200, height: 100, fills: [imagePaint('cover')], effects: [innerShadow()] })],
  });
  const { slide } = await run(frame({ width: 800, height: 600, children: [card] }), {}, env);
  const pic = flat(slide.elements).find((e) => e.id === 'photo') as ImageElement;
  expect(pic).toMatchObject({ geometry: 'roundRect', cornerRadius: 16, shadow: { type: 'inner' } });
});

it('card-cover image with an outside stroke is not native either (the card cuts the stroke)', async () => {
  const env = new FakeEnv();
  env.addImage('cover', makePng(400, 200), 400, 200);
  const card = frame({
    id: 'card', x: 50, y: 50, width: 200, height: 100, cornerRadius: 16,
    children: [rect({ id: 'photo', width: 200, height: 100, fills: [imagePaint('cover')], strokes: [solid('#000000')], strokeAlign: 'OUTSIDE', renderPad: 1 })],
  });
  const { slide } = await run(frame({ width: 800, height: 600, children: [card] }), {}, env);
  const els = flat(slide.elements);
  expect(els.find((e) => e.id === 'photo')).toBeUndefined();
  expect((els.find((e) => e.id === '~clip:photo') as ImageElement).rasterized?.reasons).toEqual(['clip']);
});

it('image with an outer shadow cut by a rectangular clipping frame → rasterized, no native shadow', async () => {
  const env = new FakeEnv();
  env.addImage('photo', makePng(400, 200), 400, 200);
  const panel = frame({
    id: 'panel', x: 100, y: 100, width: 200, height: 200,
    children: [rect({ id: 'img', x: 100, y: 20, width: 200, height: 100, fills: [imagePaint('photo')], effects: [dropShadow()] })],
  });
  const { slide } = await run(frame({ width: 800, height: 600, children: [panel] }), { preserveGroups: false }, env);
  const img = flat(slide.elements).find((e) => e.id === 'img') as ImageElement;
  expect(img.shadow).toBeNull();
  expect(img.rasterized?.reasons).toEqual(['clip']);
});

it('only the shadow reaches past the clipping frame → still rasterized (Figma cuts the shadow)', async () => {
  const env = new FakeEnv();
  env.addImage('photo', makePng(400, 200), 400, 200);
  const panel = frame({
    id: 'panel', x: 100, y: 100, width: 200, height: 200,
    children: [rect({ id: 'img', x: 0, y: 0, width: 200, height: 196, fills: [imagePaint('photo')], effects: [dropShadow()], renderPad: 12 })],
  });
  const { slide } = await run(frame({ width: 800, height: 600, children: [panel] }), { preserveGroups: false }, env);
  const img = flat(slide.elements).find((e) => e.id === 'img') as ImageElement;
  expect(img.rasterized?.reasons).toEqual(['clip']);
});

it('image with an outer shadow fully inside its frame stays native with the shadow', async () => {
  const env = new FakeEnv();
  env.addImage('photo', makePng(400, 200), 400, 200);
  const panel = frame({
    id: 'panel', x: 100, y: 100, width: 400, height: 300,
    children: [rect({ id: 'img', x: 50, y: 50, width: 200, height: 100, fills: [imagePaint('photo')], effects: [dropShadow()], renderPad: 12 })],
  });
  const { slide } = await run(frame({ width: 800, height: 600, children: [panel] }), { preserveGroups: false }, env);
  const img = flat(slide.elements).find((e) => e.id === 'img') as ImageElement;
  expect(img.rasterized).toBeUndefined();
  expect(img.shadow?.type).toBe('outer');
});
