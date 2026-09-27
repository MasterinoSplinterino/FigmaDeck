/** Shared helpers for extract/ tests that run the whole extractor on mock nodes. */
import { expect } from 'vitest';
import { extractDeck, type ExtractDeckOptions } from '../../src/extract';
import type { Element, GroupElement } from '../../src/ir/types';
import { DEFAULT_SETTINGS, type ExportSettings } from '../../src/shared/settings';
import { FakeEnv, onPage, scene, type MockNode } from '../helpers/figma-mocks';

/** Extract one slide (the root is put on a page when it has none); no temporary node may survive. */
export async function run(root: MockNode, settings: Partial<ExportSettings> = {}, env = new FakeEnv(), extra: Partial<ExtractDeckOptions> = {}) {
  if (!root.parent) onPage(root);
  const result = await extractDeck([scene(root)], { settings: { ...DEFAULT_SETTINGS, ...settings }, env, ...extra });
  expect(env.liveClones()).toEqual([]);
  return { result, slide: result.slides[0], env, report: result.report };
}

/** Depth-first flatten (groups expanded, the group itself listed before its children). */
export function flat(els: readonly Element[]): Element[] {
  const out: Element[] = [];
  for (const e of els) {
    out.push(e);
    if (e.type === 'group') out.push(...flat((e as GroupElement).children));
  }
  return out;
}
