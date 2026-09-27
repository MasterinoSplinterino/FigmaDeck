/**
 * End-to-end probe with LibreOffice: does an office suite actually USE a font embedded by embedFontsIntoPptx?
 *
 * The probe font is Liberation Sans Regular renamed to "FdEmbProbe Sans" (same-length name-table edit), so the
 * family is certainly not installed. A pptxgenjs slide sets its text in that face; the font is embedded; the PPTX
 * is converted to PDF and `pdffonts` shows which font LibreOffice rendered with.
 *
 *  - control: with the renamed font installed through a private fontconfig file, the PDF must use it
 *    (proves the renamed font and the detection work);
 *  - embedded only: LibreOffice reads `<p:embeddedFontLst>` since 25.8 (needs its libeot support, on by default
 *    on Linux / macOS / Windows builds); older versions ignore it and fall back to another font.
 *
 * Skipped when soffice / pdffonts / pdfinfo or Liberation Sans are missing. Outcome recorded in docs/font-embedding.md.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedFontsIntoPptx } from '../../src/fonts/embed';
import { LIBERATION_SANS, hasLiberationSans, readFont, renameFamily } from './font-files';
import { makeTextPptx } from './pptx';

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, env: env ? { ...process.env, ...env } : process.env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return { status: null, stdout: '', stderr: '' };
  }
}

const available = (cmd: string, args: string[]) => run(cmd, args).status === 0;
const HAS_TOOLS = hasLiberationSans() && available('soffice', ['--version']) && available('pdffonts', ['-v']) && available('pdfinfo', ['-v']);
const PROBE = 'FdEmbProbe Sans';
const TIMEOUT = 300000;

/** LibreOffice major.minor as a number (24.2 → 24.02), 0 when unknown. */
function libreOfficeVersion(): number {
  const m = /LibreOffice (\d+)\.(\d+)/.exec(run('soffice', ['--version']).stdout);
  return m ? Number(m[1]) + Number(m[2]) / 100 : 0;
}

function convert(dir: string, file: string, outDir: string, env?: NodeJS.ProcessEnv): void {
  const profile = pathToFileURL(join(dir, `profile-${outDir.split(/[\\/]/).pop()}`)).href;
  const r = run('soffice', ['--headless', '--norestore', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', outDir, file], env);
  if (r.status !== 0) throw new Error(`soffice failed: ${r.stderr || r.stdout}`);
}

describe.skipIf(!HAS_TOOLS)('LibreOffice end-to-end: embedded font usage', () => {
  let dir = '';
  const version = HAS_TOOLS ? libreOfficeVersion() : 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fd-lo-fonts-'));
    const probe = renameFamily(readFont(LIBERATION_SANS.regular), 'Liberation', 'FdEmbProbe');
    const pptx = await makeTextPptx([{ text: 'Embedded font probe Шрифт', face: PROBE }]);
    const embedded = await embedFontsIntoPptx(pptx, [{ face: PROBE, bold: false, italic: false, bytes: probe }]);
    const file = join(dir, 'embedded.pptx');
    writeFileSync(file, embedded);

    // 1. As a recipient without the font would see it.
    convert(dir, file, join(dir, 'plain'));
    // 2. Control: the same file with the probe font installed privately.
    mkdirSync(join(dir, 'fonts'));
    writeFileSync(join(dir, 'fonts', 'FdEmbProbeSans-Regular.ttf'), probe);
    const conf = join(dir, 'fonts.conf');
    writeFileSync(
      conf,
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>` +
        `<include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${join(dir, 'fonts')}</dir>` +
        `<cachedir>${join(dir, 'fc-cache')}</cachedir></fontconfig>`,
    );
    convert(dir, file, join(dir, 'control'), { FONTCONFIG_FILE: conf });
  }, TIMEOUT);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const fontsIn = (sub: string) => run('pdffonts', [join(dir, sub, 'embedded.pdf')]).stdout;

  it('opens the package with <p:embeddedFontLst> (one page)', () => {
    const info = run('pdfinfo', [join(dir, 'plain', 'embedded.pdf')]).stdout;
    expect(/Pages:\s+(\d+)/.exec(info)?.[1]).toBe('1');
  });

  it('control: with the renamed font installed, the PDF uses it', () => {
    expect(fontsIn('control')).toMatch(/FdEmbProbe/);
  });

  it(`embedded only: ${version >= 25.08 ? 'LibreOffice ≥ 25.8 uses the embedded font' : 'LibreOffice < 25.8 ignores <p:embeddedFontLst> (falls back)'}`, () => {
    const used = /FdEmbProbe/.test(fontsIn('plain'));
    expect(used).toBe(version >= 25.08);
  });
});
