/**
 * AssetStore memory: dedupe keeps only content hashes; after a slide's assets were handed to the
 * streaming consumer the store drops its byte references. Re-sends (larger display size) exist for
 * image fills only and re-read the bytes by Figma image hash.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AssetStore, contentHash, imageKey } from '../../src/extract/assets';
import { extractDeck } from '../../src/extract';
import type { Asset } from '../../src/ir/types';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { FakeEnv, frame, imagePaint, makePng, onPage, rect, resetIds, scene, vector } from '../helpers/figma-mocks';

beforeEach(() => resetIds());

const png = (w: number, h: number) => makePng(w, h);

describe('content hash', () => {
  it('equal bytes → equal hash; different bytes (same length) or length → different hash', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(contentHash(a)).toBe(contentHash(a.slice()));
    expect(contentHash(a)).not.toBe(contentHash(new Uint8Array([1, 2, 3, 5])));
    expect(contentHash(a)).not.toBe(contentHash(new Uint8Array([4, 3, 2, 1])));
    expect(contentHash(new Uint8Array([0]))).not.toBe(contentHash(new Uint8Array([0, 0])));
    expect(contentHash(new Uint8Array([]))).toMatch(/^0:/);
  });
});

describe('AssetStore release', () => {
  it('drops its byte references after the hand-over; the handed-out objects keep theirs; dedupe still works', () => {
    const store = new AssetStore();
    const bytes = png(8, 8);
    const id = store.add({ mime: 'image/png', role: 'raster', data: bytes, width: 8, height: 8, displayWidth: 8, displayHeight: 8 });
    const [handed] = store.takeNew();
    store.releaseSent();
    expect(handed.data).toBe(bytes);
    expect(store.get(id)!.data.length).toBe(0);
    expect(store.toRecord()).toEqual({});
    // Same content later: same id, nothing new to send.
    expect(store.add({ mime: 'image/png', role: 'raster', data: bytes.slice(), width: 8, height: 8, displayWidth: 8, displayHeight: 8 })).toBe(id);
    expect(store.takeNew()).toEqual([]);
    // Different content: a new asset.
    expect(store.add({ mime: 'image/png', role: 'raster', data: png(9, 9), width: 9, height: 9 })).not.toBe(id);
  });

  it('a released raster displayed larger is not re-queued (the UI never downscales rasters), metadata grows', () => {
    const store = new AssetStore();
    const id = store.add({ mime: 'image/png', role: 'raster', data: png(4, 4), width: 4, height: 4, displayWidth: 4, displayHeight: 4 });
    store.takeNew();
    store.releaseSent();
    store.noteDisplaySize(id, 40, 40);
    expect(store.get(id)!.displayWidth).toBe(40);
    expect(store.takeNew()).toEqual([]);
  });

  it('a released image fill displayed larger is re-read by its key and re-sent with its bytes', async () => {
    const store = new AssetStore();
    const bytes = png(100, 50);
    const id = store.add({ mime: 'image/png', role: 'image-fill', data: bytes, width: 100, height: 50, displayWidth: 10, displayHeight: 5 }, imageKey('h1'));
    store.takeNew();
    store.releaseSent();
    expect(store.add({ mime: 'image/png', role: 'image-fill', data: bytes, width: 100, height: 50, displayWidth: 60, displayHeight: 30 }, imageKey('h1'))).toBe(id);
    const keys: string[] = [];
    await store.reloadPending(async (key) => {
      keys.push(key);
      return bytes;
    });
    expect(keys).toEqual([imageKey('h1')]);
    const again = store.takeNew();
    expect(again.map((a: Asset) => [a.id, a.displayWidth, a.data.length])).toEqual([[id, 60, bytes.length]]);
    store.releaseSent();
    expect(store.get(id)!.data.length).toBe(0);
  });

  it('a re-send whose bytes cannot be read again is skipped, never sent without bytes', async () => {
    const store = new AssetStore();
    const id = store.add({ mime: 'image/png', role: 'image-fill', data: png(10, 10), width: 10, height: 10, displayWidth: 1, displayHeight: 1 }, imageKey('h'));
    store.takeNew();
    store.releaseSent();
    store.noteDisplaySize(id, 5, 5);
    await store.reloadPending(async () => null);
    expect(store.takeNew()).toEqual([]);
    store.noteDisplaySize(id, 9, 9);
    await store.reloadPending(async () => {
      throw new Error('gone');
    });
    expect(store.takeNew()).toEqual([]);
  });
});

describe('streaming extraction', () => {
  it('dedupes across slides after release, re-sends only grown image fills, keeps no bytes', async () => {
    const env = new FakeEnv();
    env.addImage('logo', makePng(400, 400), 400, 400);
    const s1 = frame({ id: 's1', width: 400, height: 300, children: [vector({ id: 'v1', width: 20, height: 20 }), rect({ id: 'i1', x: 100, width: 50, height: 50, fills: [imagePaint('logo')] })] });
    const s2 = frame({ id: 's2', x: 1000, width: 400, height: 300, children: [vector({ id: 'v2', width: 20, height: 20 }), rect({ id: 'i2', x: 100, width: 200, height: 200, fills: [imagePaint('logo')] })] });
    onPage(s1, s2);
    const streamed: Array<Array<[string, number, number]>> = [];
    const result = await extractDeck([scene(s1), scene(s2)], {
      settings: { ...DEFAULT_SETTINGS, svgVectors: false },
      env,
      onSlide: (e) => void streamed.push(e.assets.map((a) => [a.id, a.data.length, a.displayWidth ?? 0])),
    });
    const ids = result.slides.map((s) => s.elements.map((e) => (e as { assetId?: string }).assetId));
    expect(ids[0][0]).toBe(ids[1][0]); // identical vector export → same asset
    expect(streamed[0].map((a) => a[0]).sort()).toEqual([ids[0][0]!, ids[0][1]!].sort());
    expect(streamed[0].every(([, bytes]) => bytes > 0)).toBe(true);
    // Slide 2: only the image fill, again with bytes and the larger display size.
    expect(streamed[1]).toEqual([[ids[1][1], makePng(400, 400).length, 200]]);
    expect(result.assets).toEqual({});
  });
});
