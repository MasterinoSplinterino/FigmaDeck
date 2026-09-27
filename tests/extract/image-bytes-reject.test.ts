/**
 * An IMAGE fill whose bytes cannot be read must not abort the export: the layer falls back to Figma's
 * own render (raster), a warning is reported, and the failure is cached as "no image" (never as a
 * rejected promise) so other layers / slides using the same image fall back too.
 */
import { beforeEach, expect, it } from 'vitest';
import { extractDeck } from '../../src/extract';
import type { ImageElement } from '../../src/ir/types';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { FakeEnv, frame, imagePaint, onPage, rect, resetIds, scene, vector } from '../helpers/figma-mocks';
import { run } from './helpers';

beforeEach(() => resetIds());

function brokenEnv() {
  const env = new FakeEnv();
  let reads = 0;
  env.getImageByHash = (hash: string) =>
    hash === 'broken'
      ? {
          getBytesAsync: () => {
            reads++;
            return Promise.reject(new Error('Image not found'));
          },
          getSizeAsync: async () => ({ width: 10, height: 10 }),
        }
      : null;
  return { env, reads: () => reads };
}

it('unreadable image bytes → the layer is rasterized and reported, the slide survives', async () => {
  const { env } = brokenEnv();
  env.failExport = (n) => n.id === 'v'; // a failing raster elsewhere is reported and skipped
  const root = frame({
    id: 'root', width: 800, height: 600,
    children: [rect({ id: 'ok', x: 300 }), vector({ id: 'v', x: 500 }), rect({ id: 'photo', fills: [imagePaint('broken')] })],
  });
  const { slide, report } = await run(root, {}, env);
  expect(slide.elements.map((e) => e.id)).toEqual(['ok', 'photo']);
  expect((slide.elements[1] as ImageElement).rasterized?.reasons).toEqual(['image-format']);
  expect(report.map((r) => [r.level, r.code, r.nodeId])).toEqual([
    ['warning', 'export-failed', 'v'],
    ['warning', 'image-unreadable', 'photo'],
    ['raster', 'rasterized', 'photo'],
  ]);
  expect(report[1].message).toContain('Image not found');
});

it('the failure is cached as null: one read, every layer and slide falls back', async () => {
  const { env, reads } = brokenEnv();
  const s1 = frame({ id: 's1', width: 400, height: 300, children: [rect({ id: 'a', fills: [imagePaint('broken')] }), rect({ id: 'b', x: 200, fills: [imagePaint('broken')] })] });
  const s2 = frame({ id: 's2', x: 1000, width: 400, height: 300, children: [rect({ id: 'c', fills: [imagePaint('broken')] })] });
  onPage(s1, s2);
  const result = await extractDeck([scene(s1), scene(s2)], { settings: DEFAULT_SETTINGS, env });
  expect(reads()).toBe(1);
  expect(result.slides.map((s) => s.elements.map((e) => [e.id, (e as ImageElement).rasterized?.reasons]))).toEqual([
    [
      ['a', ['image-format']],
      ['b', ['image-format']],
    ],
    [['c', ['image-format']]],
  ]);
  expect(result.report.filter((r) => r.code === 'image-unreadable')).toHaveLength(1);
});
