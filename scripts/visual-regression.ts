/**
 * Visual regression — a ROUGH check (LibreOffice is not PowerPoint):
 *
 *   IR fixture ─[src/build]→ .pptx ─[LibreOffice]→ .pdf ─[pdftoppm]→ one PNG per slide ─[pixelmatch]→ diff vs Figma PNGs
 *
 *   npx tsx scripts/visual-regression.ts --fixture tests/fixtures/diploma.ir.json --expected tests/visual/expected/diploma
 *       [--threshold 0.1] [--max-diff 0.02] [--out tests/visual/out] [--pptx some.pptx] [--soffice /path/to/soffice]
 *
 * --fixture   IR JSON ("Export IR JSON" from the plugin, or tests/fixtures/*.ir.json). Built with the default settings.
 * --pptx      Compare this PPTX instead of building one (e.g. a file exported by another tool). With --fixture as
 *             well, the fixture only provides slide names and placements.
 * --expected  Folder with the Figma exports: `<slide number>.png` (1-based) or `<slide name>.png`; a Figma export
 *             suffix such as "@2x" is ignored, names are compared case-insensitively after sanitizing.
 * --threshold pixelmatch per-pixel color threshold, 0..1 (default CONFIG.visual.threshold).
 * --max-diff  A slide fails when more than this share of its pixels differ, 0..1 (default CONFIG.visual.maxDiffRatio).
 * --out       Output root (default CONFIG.visual.outDir); results go to <out>/<fixture name>/:
 *             deck.pptx, deck.pdf, actual/<n>.png, diff/<n>.png, summary.json.
 *
 * Each page is rendered at the width of its expected PNG (so 1x and 2x exports both work). When the fixture is
 * known, the page is cropped to the frame's placement on the slide (slides of other sizes are letterboxed by the
 * builder). Transparent pixels of the expected PNG are composited over white (LibreOffice renders on white).
 *
 * Exit code: 0 = every compared slide within --max-diff; 1 = a slide failed, or nothing could be compared;
 * 2 = usage or tool error. Needs LibreOffice Impress (`soffice`) and poppler (`pdftoppm`, `pdfinfo`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { buildPptx } from '../src/build';
import type { BuildOptions } from '../src/build/api';
import { computeDeckLayout, type DeckLayout } from '../src/build/layout';
import { CONFIG } from '../src/config';
import { deserializeDeck } from '../src/ir/serialize';
import type { Deck } from '../src/ir/types';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface VisualOptions {
  fixture: string | null;
  pptx: string | null;
  expected: string;
  /** 0..1 */
  threshold: number;
  /** 0..1 */
  maxDiff: number;
  out: string;
  soffice: string | null;
}

export class UsageError extends Error {
  /** `--help`: print the usage and exit 0. */
  constructor(
    message: string,
    readonly help = false,
  ) {
    super(message);
  }
}

export const USAGE =
  'Usage: npx tsx scripts/visual-regression.ts (--fixture <ir.json> | --pptx <file.pptx>) --expected <dir>\n' +
  '         [--threshold 0.1] [--max-diff 0.02] [--out tests/visual/out] [--soffice <path>]';

function ratio(name: string, raw: string | undefined): number {
  const v = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(v) || v < 0 || v > 1) throw new UsageError(`${name} must be a number between 0 and 1 (got "${raw ?? ''}")`);
  return v;
}

/** Parse CLI arguments (`--name value` or `--name=value`). */
export function parseArgs(argv: ReadonlyArray<string>): VisualOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') throw new UsageError(USAGE, true);
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new UsageError(`Unexpected argument "${a}"\n${USAGE}`);
    const value = m[2] ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${m[1]} needs a value`);
    values.set(m[1], value);
  }
  const known = new Set(['fixture', 'pptx', 'expected', 'threshold', 'max-diff', 'out', 'soffice']);
  for (const k of values.keys()) if (!known.has(k)) throw new UsageError(`Unknown option --${k}\n${USAGE}`);
  const expected = values.get('expected');
  if (!expected) throw new UsageError(`--expected is required\n${USAGE}`);
  if (!values.get('fixture') && !values.get('pptx')) throw new UsageError(`--fixture or --pptx is required\n${USAGE}`);
  return {
    fixture: values.get('fixture') ?? null,
    pptx: values.get('pptx') ?? null,
    expected,
    threshold: values.has('threshold') ? ratio('--threshold', values.get('threshold')) : CONFIG.visual.threshold,
    maxDiff: values.has('max-diff') ? ratio('--max-diff', values.get('max-diff')) : CONFIG.visual.maxDiffRatio,
    out: values.get('out') ?? CONFIG.visual.outDir,
    soffice: values.get('soffice') ?? null,
  };
}

// ─── Expected image matching ─────────────────────────────────────────────────

/** Normalize a slide / file name for matching: NFC, file-system-unsafe characters → "_", spaces collapsed, lower case. */
export function sanitizeName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Matching key of an expected file: extension and a Figma scale suffix ("@2x", "@0.5x") removed, then sanitized. */
export function imageKey(fileName: string): string {
  return sanitizeName(fileName.replace(/\.png$/i, '').replace(/@\d+(?:\.\d+)?x$/i, ''));
}

export interface SlideRef {
  /** 1-based */
  index: number;
  name: string;
}

export interface ExpectedMatch {
  /** slide index → file name (inside the expected folder) */
  files: Map<number, string>;
  warnings: string[];
}

/** Pick the expected PNG of every slide: `<index>.png` first, then `<slide name>.png` (unique names only). */
export function matchExpected(slides: ReadonlyArray<SlideRef>, files: ReadonlyArray<string>): ExpectedMatch {
  const byKey = new Map<string, string[]>();
  for (const f of files) {
    if (!/\.png$/i.test(f)) continue;
    const k = imageKey(f);
    byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  const nameCount = new Map<string, number>();
  for (const s of slides) nameCount.set(sanitizeName(s.name), (nameCount.get(sanitizeName(s.name)) ?? 0) + 1);

  const out = new Map<number, string>();
  const warnings: string[] = [];
  for (const s of slides) {
    const byIndex = byKey.get(String(s.index));
    const key = sanitizeName(s.name);
    const byName = key ? byKey.get(key) : undefined;
    const pick = (list: string[]) => [...list].sort()[0];
    if (byIndex) {
      out.set(s.index, pick(byIndex));
      if (byIndex.length > 1) warnings.push(`slide ${s.index}: several files match "${s.index}" (${byIndex.join(', ')}); using ${pick(byIndex)}`);
    } else if (byName) {
      if ((nameCount.get(key) ?? 0) > 1) {
        warnings.push(`slide ${s.index} "${s.name}": several slides have this name; name the expected file ${s.index}.png`);
        continue;
      }
      out.set(s.index, pick(byName));
      if (byName.length > 1) warnings.push(`slide ${s.index}: several files match "${s.name}" (${byName.join(', ')}); using ${pick(byName)}`);
    }
  }
  return { files: out, warnings };
}

// ─── Image comparison ────────────────────────────────────────────────────────

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

/** Copy with every pixel composited over opaque white. */
export function compositeOnWhite(img: RgbaImage): RgbaImage {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    data[i] = Math.round(img.data[i] * a + 255 * (1 - a));
    data[i + 1] = Math.round(img.data[i + 1] * a + 255 * (1 - a));
    data[i + 2] = Math.round(img.data[i + 2] * a + 255 * (1 - a));
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** Sub-rectangle (clamped to the image). */
export function crop(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const x0 = Math.max(0, Math.min(img.width, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height, Math.round(y)));
  const cw = Math.max(0, Math.min(img.width - x0, Math.round(w)));
  const ch = Math.max(0, Math.min(img.height - y0, Math.round(h)));
  const data = new Uint8Array(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const src = ((y0 + row) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + cw * 4), row * cw * 4);
  }
  return { width: cw, height: ch, data };
}

export type SlideStatus = 'pass' | 'fail' | 'size-mismatch' | 'missing-expected' | 'missing-page';

export interface Comparison {
  status: 'pass' | 'fail' | 'size-mismatch';
  width: number;
  height: number;
  diffPixels: number;
  /** diffPixels / (width × height) */
  diffRatio: number;
  diff: RgbaImage | null;
  note?: string;
}

/**
 * pixelmatch of `actual` against `expected` (both composited on white). Sizes may differ by up to
 * `heightTolerancePx` rows / columns (rounding in the PDF renderer): then only the common area is compared.
 */
export function compareImages(
  expected: RgbaImage,
  actual: RgbaImage,
  threshold: number,
  maxDiff: number,
  tolerancePx: number = CONFIG.visual.heightTolerancePx,
): Comparison {
  const dw = Math.abs(expected.width - actual.width);
  const dh = Math.abs(expected.height - actual.height);
  if (dw > tolerancePx || dh > tolerancePx) {
    return {
      status: 'size-mismatch',
      width: actual.width,
      height: actual.height,
      diffPixels: expected.width * expected.height,
      diffRatio: 1,
      diff: null,
      note: `rendered ${actual.width}×${actual.height} px, expected ${expected.width}×${expected.height} px`,
    };
  }
  const w = Math.min(expected.width, actual.width);
  const h = Math.min(expected.height, actual.height);
  const a = compositeOnWhite(crop(expected, 0, 0, w, h));
  const b = compositeOnWhite(crop(actual, 0, 0, w, h));
  const diff = new Uint8Array(w * h * 4);
  const diffPixels = w * h === 0 ? 0 : pixelmatch(a.data, b.data, diff, w, h, { threshold });
  const diffRatio = w * h === 0 ? 1 : diffPixels / (w * h);
  return {
    status: diffRatio > maxDiff ? 'fail' : 'pass',
    width: w,
    height: h,
    diffPixels,
    diffRatio,
    diff: { width: w, height: h, data: diff },
    note: dw || dh ? `compared the common ${w}×${h} px (sizes differ by ${dw}×${dh} px)` : undefined,
  };
}

// ─── External tools ──────────────────────────────────────────────────────────

class ToolError extends Error {}

function tool(cmd: string, args: string[], timeout: number = CONFIG.visual.sofficeTimeoutMs): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  if (r.error) throw new ToolError(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new ToolError(`${cmd} ${args.join(' ')} failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** `--soffice`, $SOFFICE, `soffice`, `libreoffice`, the macOS app bundle — first one that answers `--version`. */
export function findSoffice(explicit: string | null): string {
  const candidates = [explicit, process.env.SOFFICE, 'soffice', 'libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'].filter(
    (c): c is string => !!c,
  );
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 60000 });
    if (!r.error && r.status === 0) return c;
    if (c === explicit) break;
  }
  throw new ToolError('LibreOffice not found (install libreoffice-impress, or pass --soffice / set SOFFICE)');
}

function pdfPageCount(pdf: string): number {
  const m = /Pages:\s+(\d+)/.exec(tool('pdfinfo', [pdf]));
  if (!m) throw new ToolError(`pdfinfo: no page count for ${pdf}`);
  return Number(m[1]);
}

function readPng(file: string): RgbaImage {
  const png = PNG.sync.read(readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

function writePng(file: string, img: RgbaImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
}

/** Render one PDF page (1-based) to a PNG exactly `widthPx` wide (height by aspect ratio). */
function renderPage(pdf: string, page: number, widthPx: number, outPrefix: string): RgbaImage {
  tool('pdftoppm', ['-png', '-f', String(page), '-l', String(page), '-singlefile', '-scale-to-x', String(widthPx), '-scale-to-y', '-1', pdf, outPrefix]);
  return readPng(`${outPrefix}.png`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export interface SlideResult {
  index: number;
  name: string;
  status: SlideStatus;
  expected?: string;
  actual?: string;
  diff?: string;
  width?: number;
  height?: number;
  diffPixels?: number;
  diffRatio?: number;
  note?: string;
}

export interface Summary {
  fixture: string | null;
  pptx: string;
  pdf: string;
  libreoffice: string;
  threshold: number;
  maxDiff: number;
  passed: boolean;
  compared: number;
  warnings: string[];
  slides: SlideResult[];
}

function buildOptions(): BuildOptions {
  return {
    textCase: DEFAULT_SETTINGS.textCase,
    widthSlackPercent: DEFAULT_SETTINGS.widthSlackPercent,
    fontOverrides: {},
    fontNaming: DEFAULT_SETTINGS.fontNaming,
    svgVectors: DEFAULT_SETTINGS.svgVectors,
    preserveGroups: DEFAULT_SETTINGS.preserveGroups,
    author: DEFAULT_SETTINGS.author,
    company: DEFAULT_SETTINGS.company,
  };
}

export async function runVisualRegression(opts: VisualOptions): Promise<Summary> {
  const expectedDir = resolve(opts.expected);
  if (!existsSync(expectedDir)) throw new UsageError(`--expected folder not found: ${expectedDir}`);
  const deck: Deck | null = opts.fixture ? deserializeDeck(readFileSync(resolve(opts.fixture), 'utf8')) : null;
  const label = basename(opts.fixture ?? opts.pptx ?? 'deck').replace(/(\.ir|\.figmadeck)?\.json$/i, '').replace(/\.pptx$/i, '');
  const outDir = resolve(opts.out, label);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'actual'), { recursive: true });
  mkdirSync(join(outDir, 'diff'), { recursive: true });

  // 1. PPTX
  const pptxFile = join(outDir, 'deck.pptx');
  if (opts.pptx) writeFileSync(pptxFile, readFileSync(resolve(opts.pptx)));
  else if (deck) writeFileSync(pptxFile, (await buildPptx(deck, buildOptions())).data);

  // 2. PDF (private LibreOffice profile: no clash with a running instance)
  const soffice = findSoffice(opts.soffice);
  const version = tool(soffice, ['--version'], 60000).trim();
  const profile = mkdtempSync(join(tmpdir(), 'fd-lo-visual-'));
  try {
    tool(soffice, ['--headless', '--norestore', `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', 'pdf', '--outdir', outDir, pptxFile]);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const pdf = join(outDir, 'deck.pdf');
  if (!existsSync(pdf)) throw new ToolError('LibreOffice produced no PDF');
  const pages = pdfPageCount(pdf);

  // 3. Slides and their expected images
  const slides: SlideRef[] = deck
    ? deck.slides.map((s, i) => ({ index: i + 1, name: s.name }))
    : Array.from({ length: pages }, (_, i) => ({ index: i + 1, name: '' }));
  const layout: DeckLayout | null = deck ? computeDeckLayout(deck.slides) : null;
  const match = matchExpected(slides, readdirSync(expectedDir));
  const warnings = [...match.warnings];
  if (deck && pages !== deck.slides.length) warnings.push(`the PDF has ${pages} pages for ${deck.slides.length} slides`);

  // 4. Render + compare
  const results: SlideResult[] = [];
  for (const s of slides) {
    const file = match.files.get(s.index);
    if (!file) {
      results.push({ index: s.index, name: s.name, status: 'missing-expected' });
      continue;
    }
    if (s.index > pages) {
      results.push({ index: s.index, name: s.name, status: 'missing-page', expected: join(expectedDir, file) });
      continue;
    }
    const expected = readPng(join(expectedDir, file));
    let actual: RgbaImage;
    const prefix = join(outDir, `page-${s.index}`);
    if (layout && deck) {
      // Render the page so that the frame's placement is exactly as wide as the expected PNG, then crop to it.
      const p = layout.placements[s.index - 1];
      const frame = deck.slides[s.index - 1];
      const pxPerPt = expected.width / (frame.width * p.scale);
      const page = renderPage(pdf, s.index, Math.max(1, Math.round(layout.widthPt * pxPerPt)), prefix);
      actual = crop(page, p.offsetX * pxPerPt, p.offsetY * pxPerPt, expected.width, frame.height * p.scale * pxPerPt);
    } else {
      actual = renderPage(pdf, s.index, expected.width, prefix);
    }
    rmSync(`${prefix}.png`, { force: true });
    const actualFile = join(outDir, 'actual', `${s.index}.png`);
    writePng(actualFile, actual);
    const cmp = compareImages(expected, actual, opts.threshold, opts.maxDiff);
    let diffFile: string | undefined;
    if (cmp.diff) {
      diffFile = join(outDir, 'diff', `${s.index}.png`);
      writePng(diffFile, cmp.diff);
    }
    results.push({
      index: s.index,
      name: s.name,
      status: cmp.status,
      expected: join(expectedDir, file),
      actual: actualFile,
      diff: diffFile,
      width: cmp.width,
      height: cmp.height,
      diffPixels: cmp.diffPixels,
      diffRatio: cmp.diffRatio,
      note: cmp.note,
    });
  }

  const compared = results.filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'size-mismatch').length;
  const failed = results.some((r) => r.status === 'fail' || r.status === 'size-mismatch' || r.status === 'missing-page');
  const summary: Summary = {
    fixture: opts.fixture ? resolve(opts.fixture) : null,
    pptx: pptxFile,
    pdf,
    libreoffice: version,
    threshold: opts.threshold,
    maxDiff: opts.maxDiff,
    passed: !failed && compared > 0,
    compared,
    warnings,
    slides: results,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

function printSummary(s: Summary): void {
  console.log(`${s.libreoffice}; threshold ${s.threshold}, max diff ${(s.maxDiff * 100).toFixed(2)}%`);
  for (const r of s.slides) {
    const pct = r.diffRatio === undefined ? '' : `${(r.diffRatio * 100).toFixed(2)}%`.padStart(8);
    console.log(`  ${String(r.index).padStart(3)}  ${r.status.padEnd(16)} ${pct}  ${r.name}${r.note ? `  (${r.note})` : ''}`);
  }
  for (const w of s.warnings) console.log(`  warning: ${w}`);
  if (s.compared === 0) console.log('  nothing was compared: check the --expected file names (<n>.png or <slide name>.png)');
  console.log(`${s.passed ? 'PASS' : 'FAIL'} — details in ${join(s.pptx, '..', 'summary.json')}`);
}

async function main(): Promise<void> {
  let opts: VisualOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    const help = e instanceof UsageError && e.help;
    (help ? console.log : console.error)((e as Error).message);
    process.exit(help ? 0 : 2);
  }
  try {
    const summary = await runVisualRegression(opts);
    printSummary(summary);
    process.exit(summary.passed ? 0 : 1);
  } catch (e) {
    console.error(e instanceof UsageError || e instanceof ToolError ? e.message : e);
    process.exit(2);
  }
}

const invokedDirectly = !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) void main();
