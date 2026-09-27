/**
 * Manual-test helper for the EXPERIMENTAL font embedding prototype (docs/MANUAL-CHECKS.md, stage 4).
 * Not a test suite (no `.test.ts`): run it with tsx.
 *
 *   npx tsx tests/fonts/embed-cli.ts --out probe.pptx --face "FdEmbProbe Sans" \
 *       --regular LiberationSans-Regular.ttf [--bold …] [--italic …] [--bold-italic …] \
 *       [--rename Liberation=FdEmbProbe] [--in deck.pptx] [--allow-preview-print false] [--allow-cff false]
 *
 * Without --in a probe presentation is created: one line of text per given style, set in --face.
 * --rename FROM=TO renames the family inside every font file first (same length; makes a copy whose family is
 * certainly not installed on the test machine). Prints the parsed font info, warnings and refusals.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FontEmbedError, embedFontsIntoPptx, parseFontInfo, type EmbedFontInput } from '../../src/fonts/embed';
import { renameFamily } from './font-files';
import { makeTextPptx, type ProbeText } from './pptx';

const SLOTS = [
  { flag: 'regular', bold: false, italic: false, label: 'Regular' },
  { flag: 'bold', bold: true, italic: false, label: 'Bold' },
  { flag: 'italic', bold: false, italic: true, label: 'Italic' },
  { flag: 'bold-italic', bold: true, italic: true, label: 'Bold Italic' },
] as const;

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`Bad argument "${argv[i]}"`);
    out.set(argv[i].slice(2), argv[i + 1]);
  }
  return out;
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const out = a.get('out');
  const face = a.get('face');
  if (!out || !face) throw new Error('--out and --face are required (see the header of tests/fonts/embed-cli.ts)');
  const rename = a.get('rename')?.split('=');

  const fonts: EmbedFontInput[] = [];
  const lines: ProbeText[] = [];
  for (const s of SLOTS) {
    const path = a.get(s.flag);
    if (!path) continue;
    let bytes: Uint8Array = new Uint8Array(readFileSync(path));
    if (rename) bytes = renameFamily(bytes, rename[0], rename[1]);
    const info = parseFontInfo(bytes);
    console.log(
      `${s.label}: "${info.family}" / "${info.subfamily}" (full "${info.fullName}", weight ${info.weightClass}, ` +
        `${info.format}, fsType 0x${info.embedding.fsType.toString(16).padStart(4, '0')} = ${info.embedding.permission})`,
    );
    fonts.push({ face, bold: s.bold, italic: s.italic, bytes });
    lines.push({ text: `${face} ${s.label} — Съешь же ещё этих мягких булок 0123`, face, bold: s.bold, italic: s.italic });
  }
  if (fonts.length === 0) throw new Error('Give at least one of --regular / --bold / --italic / --bold-italic');

  const input = a.get('in') ? new Uint8Array(readFileSync(a.get('in') as string)) : await makeTextPptx(lines);
  const result = await embedFontsIntoPptx(input, fonts, {
    allowPreviewPrint: a.get('allow-preview-print') !== 'false',
    allowCff: a.get('allow-cff') !== 'false',
    onWarning: (w) => console.warn(`warning [${w.code}] ${w.message}`),
  });
  writeFileSync(out, result);
  console.log(`Written ${out} (${(result.length / 1024).toFixed(0)} KB)`);
}

main().catch((e: unknown) => {
  console.error(e instanceof FontEmbedError ? `refused [${e.code}] ${e.message}` : e);
  process.exit(1);
});
