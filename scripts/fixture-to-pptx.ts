/**
 * IR JSON fixture ("Export IR JSON" file or tests/fixtures/*.ir.json) → .pptx, in Node.
 *
 *   npx tsx scripts/fixture-to-pptx.ts <fixture.ir.json> [out.pptx] [--slide-size=34.575x10.665] [--font-naming=full]
 *
 * Uses the default export settings (plus the optional flags). Prints the build report and the fonts the
 * file needs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buildPptx } from '../src/build';
import type { BuildOptions } from '../src/build/api';
import { deserializeDeck } from '../src/ir/serialize';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Map(
    args.filter((a) => a.startsWith('--')).map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=')] as const;
    }),
  );
  const [input, outArg] = args.filter((a) => !a.startsWith('--'));
  const usage = 'Usage: npx tsx scripts/fixture-to-pptx.ts <fixture.ir.json> [out.pptx] [--slide-size=<w>x<h> (inches)] [--font-naming=ribbi|full]';
  if (!input) {
    console.error(usage);
    process.exit(1);
  }
  let slideSize: BuildOptions['slideSize'];
  const sizeArg = flags.get('slide-size');
  if (sizeArg !== undefined) {
    const m = /^([\d.]+)x([\d.]+)$/i.exec(sizeArg);
    if (!m) {
      console.error(`Bad --slide-size "${sizeArg}". ${usage}`);
      process.exit(1);
    }
    slideSize = { widthIn: Number(m[1]), heightIn: Number(m[2]) };
  }
  const namingArg = flags.get('font-naming') ?? DEFAULT_SETTINGS.fontNaming;
  if (namingArg !== 'ribbi' && namingArg !== 'full') {
    console.error(`Bad --font-naming "${namingArg}". ${usage}`);
    process.exit(1);
  }
  const out = resolve(outArg ?? basename(input).replace(/(\.ir)?\.json$/i, '') + '.pptx');
  const deck = deserializeDeck(readFileSync(input, 'utf8'));
  const options: BuildOptions = {
    textCase: DEFAULT_SETTINGS.textCase,
    widthSlackPercent: DEFAULT_SETTINGS.widthSlackPercent,
    fontOverrides: DEFAULT_SETTINGS.fontOverrides,
    fontNaming: namingArg,
    svgVectors: DEFAULT_SETTINGS.svgVectors,
    preserveGroups: DEFAULT_SETTINGS.preserveGroups,
    author: DEFAULT_SETTINGS.author,
    company: DEFAULT_SETTINGS.company,
  };
  if (slideSize) options.slideSize = slideSize;
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
