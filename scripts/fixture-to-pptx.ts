/**
 * IR JSON fixture ("Export IR JSON" file or tests/fixtures/*.ir.json) → .pptx, in Node.
 *
 *   npx tsx scripts/fixture-to-pptx.ts <fixture.ir.json> [out.pptx]
 *
 * Uses the default export settings. Prints the build report and the fonts the file needs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buildPptx } from '../src/build';
import type { BuildOptions } from '../src/build/api';
import { deserializeDeck } from '../src/ir/serialize';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

async function main(): Promise<void> {
  const [input, outArg] = process.argv.slice(2);
  if (!input) {
    console.error('Usage: npx tsx scripts/fixture-to-pptx.ts <fixture.ir.json> [out.pptx]');
    process.exit(1);
  }
  const out = resolve(outArg ?? basename(input).replace(/(\.ir)?\.json$/i, '') + '.pptx');
  const deck = deserializeDeck(readFileSync(input, 'utf8'));
  const options: BuildOptions = {
    textCase: DEFAULT_SETTINGS.textCase,
    widthSlackPercent: DEFAULT_SETTINGS.widthSlackPercent,
    fontOverrides: DEFAULT_SETTINGS.fontOverrides,
    svgVectors: DEFAULT_SETTINGS.svgVectors,
    preserveGroups: DEFAULT_SETTINGS.preserveGroups,
    author: DEFAULT_SETTINGS.author,
    company: DEFAULT_SETTINGS.company,
  };
  const started = Date.now();
  const result = await buildPptx(deck, options);
  writeFileSync(out, result.data);
  const s = result.stats;
  console.log(`${out}: ${(result.data.length / 1024).toFixed(0)} KB in ${Date.now() - started} ms`);
  console.log(`  slides ${s.slides}, texts ${s.texts}, shapes ${s.shapes}, images ${s.images}, groups ${s.groups}`);
  for (const f of result.fonts) {
    const flags = [f.bold ? 'b' : '', f.italic ? 'i' : '', f.overridden ? 'override' : ''].filter(Boolean).join(',');
    console.log(`  font ${f.family} / ${f.style} → "${f.face}"${flags ? ` (${flags})` : ''} × ${f.runs}`);
  }
  for (const r of [...deck.report, ...result.report]) console.log(`  [${r.level}] ${r.code} ${r.slideName}${r.nodeName ? ` / ${r.nodeName}` : ''}: ${r.message}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
