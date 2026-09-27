import { describe, expect, it } from 'vitest';
import { AssetStore, fnv1a } from '../../src/extract/assets';
import { initialClip, makeRoundedClip, pushClip, reachesRoundedCorner, testClip } from '../../src/extract/clip';
import { IDENTITY } from '../../src/extract/geometry';
import { IdRegistry, executePlan, groupTransform, planElement, planJob } from '../../src/extract/plan';
import { ExtractCancelledError, isCancelledError, runPool } from '../../src/extract/pool';
import type { Element, ShapeElement } from '../../src/ir/types';
import { frame, makePng, scene } from '../helpers/figma-mocks';

const shapeEl = (id: string, x = 0, y = 0, w = 10, h = 10, rotation = 0): ShapeElement => ({
  type: 'shape',
  id,
  name: id,
  transform: { x, y, w, h, rotation, flipH: false, flipV: false },
  opacity: 1,
  shadow: null,
  geometry: 'rect',
  cornerRadius: 0,
  fill: null,
  stroke: null,
});

describe('clip state', () => {
  const slide = { x: 0, y: 0, w: 100, h: 100 };

  it('outside / inner-partial / slide-partial', () => {
    const s = pushClip(initialClip(slide), { x: 10, y: 10, w: 50, h: 50 }, null);
    expect(testClip(s, { x: 70, y: 70, w: 5, h: 5 }, null).outside).toBe(true);
    expect(testClip(s, { x: 20, y: 20, w: 5, h: 5 }, null)).toEqual({ outside: false, innerPartial: false, slidePartial: false, rounded: null });
    expect(testClip(s, { x: 50, y: 20, w: 20, h: 5 }, null)).toMatchObject({ innerPartial: true, slidePartial: false });
    const root = initialClip(slide);
    expect(testClip(root, { x: 90, y: 0, w: 20, h: 5 }, null)).toMatchObject({ innerPartial: false, slidePartial: true });
  });

  it('the root only adds its rounded corners', () => {
    const rc = makeRoundedClip(scene(frame()), IDENTITY, 100, 100, [10, 10, 10, 10]);
    const s = pushClip(initialClip(slide), slide, rc, true);
    expect(s.inner).toBeNull();
    expect(s.rounded).toHaveLength(1);
  });

  it('nested clips intersect', () => {
    const s = pushClip(pushClip(initialClip(slide), { x: 0, y: 0, w: 50, h: 100 }, null), { x: 25, y: 0, w: 50, h: 50 }, null);
    expect(s.rect).toEqual({ x: 25, y: 0, w: 25, h: 50 });
    expect(s.inner).toEqual({ x: 25, y: 0, w: 25, h: 50 });
  });

  it('rounded corners: only content in the cut-off area counts', () => {
    const rc = makeRoundedClip(scene(frame()), IDENTITY, 100, 100, [20, 20, 20, 20])!;
    expect(reachesRoundedCorner(rc, { x: 20, y: 20, w: 60, h: 60 })).toBe(false); // inner area
    expect(reachesRoundedCorner(rc, { x: 20, y: 0, w: 60, h: 10 })).toBe(false); // top edge between corners
    expect(reachesRoundedCorner(rc, { x: 0, y: 0, w: 100, h: 10 })).toBe(true); // full-width header
    expect(reachesRoundedCorner(rc, { x: 5, y: 5, w: 10, h: 10 })).toBe(true); // top-left corner square
    expect(reachesRoundedCorner(rc, { x: 8, y: 8, w: 10, h: 10 })).toBe(false); // inside the arc
    expect(reachesRoundedCorner(rc, { x: 90, y: 90, w: 10, h: 10 })).toBe(true); // bottom-right
    expect(makeRoundedClip(scene(frame()), IDENTITY, 100, 100, [0, 0, 0, 0])).toBeNull();
    expect(makeRoundedClip(scene(frame()), IDENTITY, 10, 10, [50, 0, 0, 0])?.radii).toEqual([5, 0, 0, 0]);
  });
});

describe('asset store', () => {
  it('dedupes by key and by content, ids by role', () => {
    const store = new AssetStore();
    const png = makePng(4, 4);
    const a = store.add({ mime: 'image/png', role: 'raster', data: png, width: 4, height: 4 });
    const b = store.add({ mime: 'image/png', role: 'raster', data: png.slice(), width: 4, height: 4 });
    const c = store.add({ mime: 'image/png', role: 'vector-fallback', data: png, width: 4, height: 4 });
    const d = store.add({ mime: 'image/jpeg', role: 'image-fill', data: new Uint8Array([1, 2]), width: 1, height: 1 }, 'hash:x');
    const e = store.add({ mime: 'image/jpeg', role: 'image-fill', data: new Uint8Array([9]), width: 1, height: 1 }, 'hash:x');
    expect([a, b, c, d, e]).toEqual(['ras1', 'ras1', 'vec1', 'img1', 'img1']);
    expect(store.size).toBe(3);
    expect(store.lookup('hash:x')).toBe('img1');
  });

  it('streams new assets once, re-queues grown display sizes', () => {
    const store = new AssetStore();
    const id = store.add({ mime: 'image/png', role: 'image-fill', data: makePng(2, 2), width: 2, height: 2, displayWidth: 10, displayHeight: 10 }, 'hash:a');
    expect(store.takeNew().map((x) => x.id)).toEqual([id]);
    expect(store.takeNew()).toEqual([]);
    store.noteDisplaySize(id, 5, 5);
    expect(store.takeNew()).toEqual([]);
    store.noteDisplaySize(id, 40, 20);
    const again = store.takeNew();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ displayWidth: 40, displayHeight: 20 });
    expect(store.toRecord()[id].displayWidth).toBe(40);
  });

  it('fnv1a is stable', () => {
    expect(fnv1a(new Uint8Array([]))).toBe(0x811c9dc5);
    expect(fnv1a(new Uint8Array([97]))).toBe(0xe40c292c);
  });
});

describe('pool', () => {
  it('limits concurrency and keeps order', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return i;
    });
    const done: number[] = [];
    expect(await runPool(tasks, 3, undefined, (d) => done.push(d))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(3);
    expect(done.at(-1)).toBe(10);
  });

  it('stops on failure and cancellation, waits for running tasks', async () => {
    let finished = 0;
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 5));
      finished++;
      return 1;
    };
    const failing = async () => {
      throw new Error('boom');
    };
    await expect(runPool([slow, failing, slow, slow, slow], 2)).rejects.toThrow('boom');
    expect(finished).toBe(1); // the one in flight settled, nothing new started
    let cancelled = false;
    const p = runPool(
      [
        async () => {
          cancelled = true;
          return 0;
        },
        slow,
      ],
      1,
      () => cancelled,
    );
    await expect(p).rejects.toBeInstanceOf(ExtractCancelledError);
    expect(isCancelledError(new ExtractCancelledError())).toBe(true);
    expect(isCancelledError(new Error('x'))).toBe(false);
  });
});

describe('plan assembly', () => {
  it('runs jobs, keeps paint order, groups ≥2 children, splices single ones', async () => {
    const plans = [
      planElement(shapeEl('a')),
      {
        kind: 'group' as const,
        id: 'g',
        name: 'g',
        children: [planJob('j1', async () => [shapeEl('b', 20, 0)]), planElement(shapeEl('c', 0, 30, 10, 10, 90))],
      },
      { kind: 'group' as const, id: 'single', name: 'single', children: [planJob('j2', async () => [shapeEl('d')])] },
      { kind: 'group' as const, id: 'empty', name: 'empty', children: [planJob('j3', async () => [])] },
    ];
    const out = await executePlan(plans, { concurrency: 2, preserveGroups: true });
    expect(out.map((e) => e.id)).toEqual(['a', 'g', 'd']);
    const g = out[1] as Extract<Element, { type: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b', 'c']);
    expect(g.transform).toEqual({ x: 0, y: 0, w: 30, h: 40, rotation: 0, flipH: false, flipV: false });
    expect(g.opacity).toBe(1);
    const flat = await executePlan(plans, { concurrency: 1, preserveGroups: false });
    expect(flat.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('group transform = union of rotated bounds', () => {
    expect(groupTransform([shapeEl('a', 0, 0, 100, 50, 90)])).toMatchObject({ x: 25, y: -25, w: 50, h: 100 });
  });

  it('ids are unique across the deck', () => {
    const ids = new IdRegistry();
    const els: Element[] = [shapeEl('x'), shapeEl('x'), { type: 'group', id: 'x', name: 'g', transform: shapeEl('g').transform, opacity: 1, children: [shapeEl('x')] }];
    ids.apply(els);
    expect(els.map((e) => e.id)).toEqual(['x', 'x#2', 'x#3']);
    expect((els[2] as Extract<Element, { type: 'group' }>).children[0].id).toBe('x#4');
  });
});
