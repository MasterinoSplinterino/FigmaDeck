/**
 * Shared access to the IR fixtures for build tests.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuildOptions } from '../../src/build/api';
import { CONFIG } from '../../src/config';
import { deserializeDeck } from '../../src/ir/serialize';
import type { Deck } from '../../src/ir/types';

export const FIXTURE_NAMES = ['diploma', 'kitchen-sink', 'wide-5k', 'mixed-sizes', 'tiny', 'startup-summit-wide'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** Default export settings with a fixed timestamp. Returns a fresh object on every call. */
export function testOptions(o: Partial<BuildOptions> = {}): BuildOptions {
  return {
    textCase: 'cap',
    widthSlackPercent: CONFIG.text.widthSlackPercent,
    fontOverrides: {},
    svgVectors: true,
    preserveGroups: true,
    now: new Date('2026-01-02T03:04:05.678Z'),
    ...o,
  };
}

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./${name}.ir.json`, import.meta.url));
}

export function loadFixture(name: string): Deck {
  return deserializeDeck(readFileSync(fixturePath(name), 'utf8'));
}
