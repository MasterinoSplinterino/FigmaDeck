#!/usr/bin/env node
// Renders the Figma Community listing assets from the templates in this folder with headless Chromium:
//
//   docs/publishing/icon.svg              (copy of src/icon.svg)
//   docs/publishing/icon-128.png          128×128, transparent corners
//   docs/publishing/cover-1920x1080.png   cover / thumbnail
//   docs/publishing/carousel-01…06.png    1920×1080 carousel images
//
// UI screenshots come from docs/screenshots/*.png (npm run ui:screenshots). Re-run this script after
// regenerating them — nothing else needs to change. Missing screenshots render as a striped placeholder
// and are reported.
//
// Usage (from the repository root, after `npm ci`):
//   node docs/publishing/src/render.mjs                    # everything
//   node docs/publishing/src/render.mjs --only cover,carousel-03
//   node docs/publishing/src/render.mjs --preview [dir]    # + icon size sheet (16…128 px on light / dark),
//                                                          #   default dir: <os tmp>/ewento-slides-preview
//
// Chromium: $PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers (as scripts/ui-screenshots.mjs), otherwise
// the browser installed for playwright-core (`npx playwright-core install chromium`).
import { chromium } from 'playwright-core';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(SRC, '..');
const SHOTS_DIR = resolve(SRC, '../../screenshots');

const ASSETS = [
  { name: 'icon-128', page: 'icon.svg', width: 128, height: 128, transparent: true },
  { name: 'cover-1920x1080', page: 'cover.html', width: 1920, height: 1080 },
  { name: 'carousel-01', page: 'carousel-01.html', width: 1920, height: 1080 },
  { name: 'carousel-02', page: 'carousel-02.html', width: 1920, height: 1080 },
  { name: 'carousel-03', page: 'carousel-03.html', width: 1920, height: 1080 },
  { name: 'carousel-04', page: 'carousel-04.html', width: 1920, height: 1080 },
  { name: 'carousel-05', page: 'carousel-05.html', width: 1920, height: 1080 },
  { name: 'carousel-06', page: 'carousel-06.html', width: 1920, height: 1080 },
];

/** `--name value` → value; `--name` without a value → ''; absent → null. */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter((r) => r && existsSync(r));
  for (const r of roots) {
    for (const dir of readdirSync(r).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const bin = join(r, dir, rel);
        if (existsSync(bin)) return bin;
      }
    }
  }
  return undefined; // playwright-core's own lookup
}

function pngSize(file) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** Every docs/screenshots/*.png as { name: { url, w, h, file, mtime } }. */
function screenshotIndex() {
  const index = {};
  if (!existsSync(SHOTS_DIR)) return index;
  for (const f of readdirSync(SHOTS_DIR)) {
    if (!f.endsWith('.png')) continue;
    const file = join(SHOTS_DIR, f);
    index[f.slice(0, -4)] = { url: pathToFileURL(file).href, ...pngSize(file), file: f, mtime: statSync(file).mtime };
  }
  return index;
}

const only = arg('only') ? new Set(arg('only').split(',').map((s) => s.trim())) : null;
const previewDir = arg('preview');
const shots = screenshotIndex();

copyFileSync(join(SRC, 'icon.svg'), join(OUT, 'icon.svg'));
console.log('icon.svg');

const browser = await chromium.launch({ executablePath: findChromium() });
const problems = [];
try {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  await context.addInitScript((s) => { window.__SHOTS__ = s; }, shots);

  for (const asset of ASSETS) {
    if (only && !only.has(asset.name)) continue;
    const page = await context.newPage();
    await page.setViewportSize({ width: asset.width, height: asset.height });
    await page.goto(pathToFileURL(join(SRC, asset.page)).href);
    if (asset.page.endsWith('.html')) await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 30000 });

    const used = await page.evaluate(() => [...document.querySelectorAll('[data-shot]')].map((e) => e.dataset.shot));
    const report = await page.evaluate(() => {
      const issues = [];
      // Text that overflows its box (elements marked data-fit, plus the text column).
      for (const el of document.querySelectorAll('[data-fit], .text')) {
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
          issues.push(`overflow: <${el.tagName.toLowerCase()} class="${el.className}"> ${el.scrollWidth}×${el.scrollHeight} > ${el.clientWidth}×${el.clientHeight}`);
        }
      }
      // Text outside the canvas.
      const W = window.innerWidth, H = window.innerHeight;
      for (const el of document.querySelectorAll('h1, h2, p, li, span, .chip, .badge')) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H)) {
          issues.push(`off-canvas: <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 40)}"`);
        }
      }
      return issues;
    });

    const file = join(OUT, `${asset.name}.png`);
    await page.screenshot({ path: file, omitBackground: !!asset.transparent });
    const usedInfo = [...new Set(used)].map((n) => (shots[n] ? `${shots[n].file} (${shots[n].w}×${shots[n].h})` : `MISSING ${n}.png`));
    console.log(`${asset.name}.png${usedInfo.length ? `  ← ${usedInfo.join(', ')}` : ''}`);
    for (const n of used) if (!shots[n]) problems.push(`${asset.name}: screenshot docs/screenshots/${n}.png not found`);
    for (const r of report) problems.push(`${asset.name}: ${r}`);
    await page.close();
  }

  if (previewDir !== null) {
    const dir = resolve(previewDir || join(tmpdir(), 'ewento-slides-preview'));
    mkdirSync(dir, { recursive: true });
    const page = await context.newPage();
    // The listing uploads the 128 px PNG; Figma scales it down, so preview that PNG.
    const png = `data:image/png;base64,${readFileSync(join(OUT, 'icon-128.png')).toString('base64')}`;
    const sizes = [16, 24, 32, 48, 64, 128];
    const row = (bg) => `<div style="display:flex;gap:28px;align-items:center;padding:28px;background:${bg}">${sizes.map((s) => `<img src="${png}" width="${s}" height="${s}">`).join('')}</div>`;
    await page.setContent(`<body style="margin:0">${row('#ffffff')}${row('#2c2c2c')}${row('#f5f4fb')}</body>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.screenshot({ path: join(dir, 'icon-sizes.png'), fullPage: true });
    console.log(`preview → ${join(dir, 'icon-sizes.png')}`);
  }
} finally {
  await browser.close();
}

if (problems.length) {
  console.warn(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
}
