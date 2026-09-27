/**
 * Smoke test with a real office suite: every fixture PPTX must open in LibreOffice Impress and convert
 * to a PDF with one page per slide and the expected page size. Skipped when `soffice` is not installed.
 * (LibreOffice is not PowerPoint; this catches broken packages, not pixel differences.)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import { FIXTURE_NAMES, loadFixture, testOptions } from '../fixtures/load';
import { openPptx, slideSize } from '../helpers/ooxml';

function available(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
}

const HAS_TOOLS = available('soffice', ['--version']) && available('pdfinfo', ['-v']);
const TIMEOUT = 300000;

describe.skipIf(!HAS_TOOLS)('LibreOffice smoke test', () => {
  let dir = '';
  const expected = new Map<string, { slides: number; widthPt: number; heightPt: number }>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fd-lo-'));
    const files: string[] = [];
    for (const name of FIXTURE_NAMES) {
      const deck = loadFixture(name);
      const result = await buildPptx(deck, testOptions());
      const file = join(dir, `${name}.pptx`);
      writeFileSync(file, result.data);
      files.push(file);
      const { cx, cy } = slideSize(await openPptx(result.data));
      expected.set(name, { slides: deck.slides.length, widthPt: cx / 12700, heightPt: cy / 12700 });
    }
    const profile = pathToFileURL(join(dir, 'profile')).href;
    const res = spawnSync('soffice', ['--headless', '--norestore', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', dir, ...files], {
      encoding: 'utf8',
      timeout: TIMEOUT - 10000,
    });
    if (res.status !== 0) throw new Error(`soffice failed: ${res.stderr || res.stdout}`);
  }, TIMEOUT);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(FIXTURE_NAMES)('%s converts to a PDF with one page per slide', (name) => {
    const info = spawnSync('pdfinfo', [join(dir, `${name}.pdf`)], { encoding: 'utf8' });
    expect(info.status).toBe(0);
    const pages = Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1]);
    const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info.stdout);
    const want = expected.get(name)!;
    expect(pages).toBe(want.slides);
    expect(Number(size?.[1])).toBeCloseTo(want.widthPt, 0);
    expect(Number(size?.[2])).toBeCloseTo(want.heightPt, 0);
  });

  it.skipIf(!available('pdftoppm', ['-v']))('renders visible content (not a blank page)', () => {
    for (const name of ['diploma', 'kitchen-sink']) {
      const prefix = join(dir, `${name}-render`);
      expect(spawnSync('pdftoppm', ['-png', '-r', '24', '-f', '1', '-l', '1', '-singlefile', join(dir, `${name}.pdf`), prefix]).status).toBe(0);
      const png = PNG.sync.read(readFileSync(`${prefix}.png`));
      const colors = new Set<number>();
      for (let i = 0; i < png.data.length; i += 4) colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
      expect(colors.size).toBeGreaterThan(20);
    }
  });
});
