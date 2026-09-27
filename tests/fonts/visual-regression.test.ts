/**
 * scripts/visual-regression.ts: argument parsing, expected-file matching, image comparison, and one end-to-end run
 * against LibreOffice (skipped without soffice / pdftoppm / pdfinfo).
 *
 * (Kept in tests/fonts/ because that is the test folder owned by the stage-4 / tooling work; it only depends on
 * the script's exports.)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { serializeDeck } from '../../src/ir/serialize';
import {
  compareImages,
  compositeOnWhite,
  crop,
  imageKey,
  matchExpected,
  parseArgs,
  runVisualRegression,
  sanitizeName,
  UsageError,
  type RgbaImage,
} from '../../scripts/visual-regression';
import { deck, makePng, rgb, shape, slide, tf, type Rgba } from '../fixtures/ir-builders';

function solid(width: number, height: number, pixel: (x: number, y: number) => Rgba): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}

describe('parseArgs', () => {
  it('reads options in both forms and falls back to CONFIG.visual', () => {
    expect(parseArgs(['--fixture', 'a.ir.json', '--expected=exp'])).toEqual({
      fixture: 'a.ir.json',
      pptx: null,
      expected: 'exp',
      threshold: CONFIG.visual.threshold,
      maxDiff: CONFIG.visual.maxDiffRatio,
      out: CONFIG.visual.outDir,
      soffice: null,
    });
    expect(parseArgs(['--pptx', 'x.pptx', '--expected', 'e', '--threshold', '0.2', '--max-diff=0.05', '--out', 'o', '--soffice', '/opt/lo'])).toMatchObject({
      pptx: 'x.pptx',
      threshold: 0.2,
      maxDiff: 0.05,
      out: 'o',
      soffice: '/opt/lo',
    });
  });

  it('rejects missing, unknown and out-of-range options', () => {
    expect(() => parseArgs(['--fixture', 'a'])).toThrow(/--expected is required/);
    expect(() => parseArgs(['--expected', 'e'])).toThrow(/--fixture or --pptx/);
    expect(() => parseArgs(['--fixture', 'a', '--expected', 'e', '--threshold', '2'])).toThrow(/between 0 and 1/);
    expect(() => parseArgs(['--fixture', 'a', '--expected', 'e', '--max-diff', 'x'])).toThrow(/between 0 and 1/);
    expect(() => parseArgs(['--fixture', 'a', '--expected', 'e', '--colour', 'red'])).toThrow(/Unknown option --colour/);
    expect(() => parseArgs(['--fixture'])).toThrow(/needs a value/);
    expect(() => parseArgs(['stray'])).toThrow(/Unexpected argument/);
    try {
      parseArgs(['--help']);
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect((e as UsageError).help).toBe(true);
    }
  });
});

describe('expected file matching', () => {
  it('sanitizes names and drops Figma scale suffixes', () => {
    expect(sanitizeName('  Title / Intro:  v2 ')).toBe('title _ intro_ v2');
    expect(imageKey('Slide 1@2x.png')).toBe('slide 1');
    expect(imageKey('3@0.5x.PNG')).toBe('3');
    expect(imageKey('Диплом.png')).toBe('диплом');
  });

  it('prefers <index>.png, falls back to the slide name, warns about ambiguity', () => {
    const slides = [
      { index: 1, name: 'Cover' },
      { index: 2, name: 'Agenda' },
      { index: 3, name: 'Dup' },
      { index: 4, name: 'Dup' },
      { index: 5, name: 'Missing' },
    ];
    const files = ['1.png', 'cover.png', 'Agenda@2x.png', 'dup.png', 'notes.txt', '4.png'];
    const m = matchExpected(slides, files);
    expect([...m.files.entries()]).toEqual([
      [1, '1.png'],
      [2, 'Agenda@2x.png'],
      [4, '4.png'],
    ]);
    expect(m.warnings).toEqual([expect.stringContaining('slide 3 "Dup": several slides have this name')]);
  });
});

describe('image helpers', () => {
  it('composites transparency over white and crops with clamping', () => {
    const img = solid(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [255, 0, 0, 128]));
    expect([...compositeOnWhite(img).data]).toEqual([255, 255, 255, 255, 255, 127, 127, 255]);
    const big = solid(4, 3, (x, y) => [x, y, 0, 255]);
    const c = crop(big, 1, 1, 10, 10);
    expect([c.width, c.height]).toEqual([3, 2]);
    expect([...c.data.subarray(0, 4)]).toEqual([1, 1, 0, 255]);
  });

  it('compares identical, different and differently sized images', () => {
    const a = solid(20, 10, () => [10, 20, 30, 255]);
    expect(compareImages(a, a, 0.1, 0.02)).toMatchObject({ status: 'pass', diffPixels: 0, diffRatio: 0 });
    const b = solid(20, 10, (x) => (x < 5 ? [250, 20, 30, 255] : [10, 20, 30, 255]));
    const cmp = compareImages(a, b, 0.1, 0.02);
    expect(cmp.status).toBe('fail');
    expect(cmp.diffRatio).toBeCloseTo(0.25, 5);
    expect(cmp.diff?.width).toBe(20);
    // 1 px taller: within tolerance, the common area is compared
    const c = solid(20, 11, () => [10, 20, 30, 255]);
    expect(compareImages(a, c, 0.1, 0.02)).toMatchObject({ status: 'pass', height: 10 });
    expect(compareImages(a, solid(20, 30, () => [10, 20, 30, 255]), 0.1, 0.02)).toMatchObject({ status: 'size-mismatch', diffRatio: 1 });
  });
});

// ─── End-to-end with LibreOffice ─────────────────────────────────────────────

function available(cmd: string): boolean {
  try {
    return spawnSync(cmd, [cmd === 'soffice' ? '--version' : '-v'], { stdio: 'ignore', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
}

const HAS_TOOLS = available('soffice') && available('pdftoppm') && available('pdfinfo');

/**
 * Two slides whose look is fully known without any renderer: solid backgrounds and axis-aligned rectangles.
 * The second (square) slide is letterboxed into the first slide's size by the builder, so the run also checks
 * that the page is cropped to the frame's placement.
 */
const BLUE = '1E3A8A';
const AMBER = 'F59E0B';
const GREEN = '065F46';
const rgbOf = (hex: string): Rgba => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];

function syntheticDeck() {
  return deck('Visual probe', [
    slide('1:1', 'Wide', 400, 200, [shape('Block', 'rect', tf(40, 40, 120, 80), { fill: { type: 'solid', color: rgb(AMBER) } })], {
      background: { type: 'solid', color: rgb(BLUE) },
    }),
    slide('1:2', 'Square', 200, 200, [shape('Block', 'rect', tf(100, 20, 60, 160), { fill: { type: 'solid', color: rgb(AMBER) } })], {
      background: { type: 'solid', color: rgb(GREEN) },
    }),
  ]);
}

/** Expected PNG of a frame at `scale` (px per frame px), drawn from the same geometry. */
function expectedPng(width: number, height: number, scale: number, bg: string, rect: [number, number, number, number]): Uint8Array {
  const [rx, ry, rw, rh] = rect;
  return makePng(width * scale, height * scale, (x, y) => {
    const fx = (x + 0.5) / scale;
    const fy = (y + 0.5) / scale;
    return fx >= rx && fx < rx + rw && fy >= ry && fy < ry + rh ? rgbOf(AMBER) : rgbOf(bg);
  });
}

describe.skipIf(!HAS_TOOLS)('visual regression end-to-end (LibreOffice)', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fd-visual-'));
    writeFileSync(join(dir, 'probe.ir.json'), serializeDeck(syntheticDeck()));
    mkdirSync(join(dir, 'good'));
    writeFileSync(join(dir, 'good', '1.png'), expectedPng(400, 200, 2, BLUE, [40, 40, 120, 80])); // 2x export
    writeFileSync(join(dir, 'good', 'Square.png'), expectedPng(200, 200, 1, GREEN, [100, 20, 60, 160])); // 1x, by name
    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'bad', '1.png'), expectedPng(400, 200, 1, BLUE, [240, 40, 120, 80])); // block moved
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('passes when the render matches the expected PNGs (1x and 2x, letterboxed slide cropped)', async () => {
    const summary = await runVisualRegression({
      fixture: join(dir, 'probe.ir.json'),
      pptx: null,
      expected: join(dir, 'good'),
      threshold: 0.1,
      maxDiff: 0.02,
      out: join(dir, 'out'),
      soffice: null,
    });
    expect(summary.slides.map((s) => [s.index, s.status, s.width, s.height])).toEqual([
      [1, 'pass', 800, 400],
      [2, 'pass', 200, 200],
    ]);
    for (const s of summary.slides) expect(s.diffRatio).toBeLessThan(0.02);
    expect(summary.passed).toBe(true);
    const outDir = join(dir, 'out', 'probe');
    expect(JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')).passed).toBe(true);
    for (const f of ['deck.pptx', 'deck.pdf', 'actual/1.png', 'actual/2.png', 'diff/1.png', 'diff/2.png']) expect(existsSync(join(outDir, f))).toBe(true);
  }, 180000);

  it('fails (exit code 1) when a slide differs, and lists slides without an expected image', () => {
    const cli = resolve('node_modules/tsx/dist/cli.mjs');
    const r = spawnSync(
      process.execPath,
      [cli, 'scripts/visual-regression.ts', '--fixture', join(dir, 'probe.ir.json'), '--expected', join(dir, 'bad'), '--out', join(dir, 'out-bad')],
      { encoding: 'utf8', timeout: 180000 },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/1 {2}fail/);
    expect(r.stdout).toMatch(/2 {2}missing-expected/);
    const summary = JSON.parse(readFileSync(join(dir, 'out-bad', 'probe', 'summary.json'), 'utf8'));
    expect(summary.slides[0].diffRatio).toBeGreaterThan(0.1);
  }, 180000);
});
