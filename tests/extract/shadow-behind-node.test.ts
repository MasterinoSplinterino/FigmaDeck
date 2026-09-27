/**
 * DROP_SHADOW with `showShadowBehindNode: false` (Figma's default) is hidden behind the node; PowerPoint
 * draws an outer shadow behind the whole shape, visible through a translucent fill. Such layers are
 * rasterized ('effects') when the effective fill alpha (fill × layer × ancestors) is below 1 or there is
 * no fill; opaque fills keep the native shadow.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Element, ImageElement } from '../../src/ir/types';
import { FakeEnv, dropShadow, ellipse, frame, group, imagePaint, innerShadow, linear, makePng, rect, resetIds, solid, text, type MockNode } from '../helpers/figma-mocks';
import { flat, run } from './helpers';

beforeEach(() => resetIds());

const hidden = (extra: Record<string, unknown> = {}) => dropShadow({ showShadowBehindNode: false, ...extra });

async function one(node: MockNode, env = new FakeEnv()): Promise<Element> {
  const { slide } = await run(frame({ width: 800, height: 600, children: [node] }), { preserveGroups: false }, env);
  return flat(slide.elements).find((e) => e.id === node.id || e.id === `~bg:${node.id}`)!;
}

const reasons = (e: Element) => (e.type === 'image' ? ((e as ImageElement).rasterized?.reasons ?? null) : null);

describe('shapes', () => {
  it('opaque fill keeps the native shadow (default showShadowBehindNode: undefined = false)', async () => {
    const e = await one(rect({ id: 'r', fills: [solid('#ff0000')], effects: [dropShadow()] }));
    expect(e).toMatchObject({ type: 'shape', shadow: { type: 'outer' } });
  });

  it('translucent fill (paint opacity / color alpha) → rasterized', async () => {
    expect(reasons(await one(rect({ id: 'r', fills: [solid('#ff0000', 0.5)], effects: [hidden()] })))).toEqual(['effects']);
    expect(reasons(await one(ellipse({ id: 'e', fills: [solid('#ff0000', 0.8)], effects: [dropShadow()] })))).toEqual(['effects']);
  });

  it('showShadowBehindNode: true → PowerPoint looks the same → native', async () => {
    const e = await one(rect({ id: 'r', fills: [solid('#ff0000', 0.5)], effects: [dropShadow({ showShadowBehindNode: true })] }));
    expect(e).toMatchObject({ type: 'shape', shadow: { type: 'outer' } });
  });

  it('no fill (stroke only) → rasterized', async () => {
    expect(reasons(await one(rect({ id: 'r', fills: [], strokes: [solid('#000000')], effects: [hidden()] })))).toEqual(['effects']);
  });

  it('gradient with a transparent stop → rasterized', async () => {
    const r = rect({ id: 'r', fills: [linear([[0, '#ff0000', 1], [1, '#0000ff', 0]])], effects: [hidden()] });
    expect(reasons(await one(r))).toEqual(['effects']);
  });

  it('layer opacity and ancestors\' opacity count', async () => {
    expect(reasons(await one(rect({ id: 'r', opacity: 0.5, effects: [hidden()] })))).toEqual(['effects']);
    const { slide } = await run(
      frame({ width: 800, height: 600, children: [group({ id: 'g', opacity: 0.5, children: [rect({ id: 'r', effects: [hidden()] })] })] }),
      { preserveGroups: false },
    );
    expect(slide.elements.map((e) => [e.id, reasons(e)])).toEqual([['r', ['effects']]]);
  });

  it('inner shadows are not affected', async () => {
    const e = await one(rect({ id: 'r', fills: [solid('#ff0000', 0.5)], effects: [innerShadow()] }));
    expect(e).toMatchObject({ type: 'shape', shadow: { type: 'inner' } });
  });
});

describe('text, pictures, frame backgrounds', () => {
  it('text: translucent color or layer opacity → rasterized; opaque → native', async () => {
    expect(await one(text({ id: 't', effects: [hidden()] }))).toMatchObject({ type: 'text', shadow: { type: 'outer' } });
    expect(reasons(await one(text({ id: 't', fills: [solid('#000000', 0.5)], effects: [hidden()] })))).toEqual(['effects']);
    expect(reasons(await one(text({ id: 't', opacity: 0.6, effects: [hidden()] })))).toEqual(['effects']);
  });

  it('image fill with a translucent paint → rasterized; opaque → native picture with shadow', async () => {
    const env = new FakeEnv();
    env.addImage('photo', makePng(200, 100), 200, 100);
    expect(await one(rect({ id: 'p', width: 200, height: 100, fills: [imagePaint('photo')], effects: [hidden()] }), env)).toMatchObject({
      type: 'image',
      shadow: { type: 'outer' },
    });
    const faded = rect({ id: 'p', width: 200, height: 100, fills: [imagePaint('photo', 'FILL', { opacity: 0.5 })], effects: [hidden()] });
    expect(reasons(await one(faded, env))).toEqual(['effects']);
  });

  it('frame with a translucent fill: its background (fill + shadow) becomes an own-paint composite', async () => {
    const card = frame({ id: 'card', x: 10, y: 10, width: 200, height: 100, fills: [solid('#ffffff', 0.6)], effects: [hidden()], children: [text({ id: 't', x: 20, y: 20 })] });
    const { slide } = await run(frame({ width: 800, height: 600, children: [card] }), { preserveGroups: false });
    expect(slide.elements.map((e) => [e.id, reasons(e)])).toEqual([
      ['~bg:card', ['effects']],
      ['t', null],
    ]);
  });
});
