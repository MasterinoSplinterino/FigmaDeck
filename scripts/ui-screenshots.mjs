// Renders the plugin UI standalone in headless Chromium and saves screenshots of its main states:
//   docs/screenshots/{empty,deck,export-menu,settings,settings-fonts,progress,report}.png
//
// The UI is bundled exactly like scripts/build.mjs does (same esbuild options, Node-only modules
// stubbed, JS + CSS inlined into src/ui/index.html). `parent.postMessage` is stubbed (at top level
// `parent === window`) and main-thread messages are injected as window 'message' events. The report
// scene runs the real export pipeline (images → buildPptx in the browser) on IR fixtures and checks
// the downloaded .pptx.
//
// Usage: node scripts/ui-screenshots.mjs [--theme dark|light] [--lang en|ru] [--out docs/screenshots]
import * as esbuild from 'esbuild';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const theme = arg('theme', 'dark');
const lang = arg('lang', 'en');
const outDir = resolve(root, arg('out', 'docs/screenshots'));
const suffix = `${theme === 'light' ? '-light' : ''}${lang === 'ru' ? '-ru' : ''}`;
const WINDOW = { width: 1000, height: 640 };

// ─── Bundle (mirrors uiOptions in scripts/build.mjs) ─────────────────────────

const nodeOnly = ['fs', 'https', 'http', 'path', 'os', 'stream', 'image-size', 'node:fs', 'node:https', 'node:path'];
const emptyNodeModules = {
  name: 'empty-node-modules',
  setup(build) {
    const filter = new RegExp(`^(${nodeOnly.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'empty-node' }));
    build.onLoad({ filter: /.*/, namespace: 'empty-node' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

async function buildUiHtml() {
  const result = await esbuild.build({
    entryPoints: [resolve(root, 'src/ui/main.tsx')],
    outdir: resolve(root, 'dist/ui-tmp'),
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: false,
    logLevel: 'warning',
    loader: { '.svg': 'text' },
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), global: 'globalThis' },
    plugins: [emptyNodeModules],
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const template = await readFile(resolve(root, 'src/ui/index.html'), 'utf8');
  return template
    .replace('<!-- INLINE_CSS -->', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<!-- INLINE_JS -->', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}

function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter((r) => r && existsSync(r));
  for (const r of roots) {
    for (const dir of readdirSync(r)) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const bin = join(r, dir, rel);
        if (existsSync(bin)) return bin;
      }
    }
  }
  throw new Error('Chromium not found (set PLAYWRIGHT_BROWSERS_PATH)');
}

// ─── Demo data ───────────────────────────────────────────────────────────────

const SLIDES = [
  { id: '1:10', name: lang === 'ru' ? 'Взрывной рост' : 'Explosive growth', width: 1080, height: 1440, pageId: '0:1', pageName: 'Deck', art: 'poster' },
  { id: '1:11', name: 'Startup Summit 2026', width: 1920, height: 1080, pageId: '0:1', pageName: 'Deck', art: 'title' },
  { id: '1:12', name: lang === 'ru' ? 'Программа' : 'Agenda', width: 1920, height: 1080, pageId: '0:1', pageName: 'Deck', art: 'agenda' },
  { id: '1:13', name: lang === 'ru' ? 'Метрики роста' : 'Growth metrics', width: 1920, height: 1080, pageId: '0:1', pageName: 'Deck', art: 'chart' },
  { id: '1:14', name: lang === 'ru' ? 'Команда' : 'Team', width: 1920, height: 1080, pageId: '0:1', pageName: 'Deck', art: 'team' },
  { id: '1:15', name: lang === 'ru' ? 'Старое интро' : 'Old intro', width: 1920, height: 1080, pageId: '0:1', pageName: 'Deck', art: 'title', missing: true },
];

const SETTINGS = {
  mode: 'editable',
  rasterScale: 2,
  jpeg: true,
  jpegQuality: 0.85,
  textCase: 'cap',
  widthSlackPercent: 3,
  svgVectors: true,
  preserveGroups: true,
  nativeGradients: true,
  imageFills: 'original',
  clippedText: 'rasterize',
  fontNaming: 'ribbi',
  fontOverrides: { 'Montserrat::Black': { face: 'Montserrat Black', bold: false, italic: false } },
  slideSizeMode: 'frame',
  slideWidthIn: 13.333,
  slideHeightIn: 7.5,
  author: 'Anna Petrova',
  company: 'Startup Summit',
};

const FONTS = [
  { family: 'SB Sans Display', style: 'Semibold', count: 42, missing: false },
  { family: 'SB Sans Display', style: 'Bold', count: 12, missing: false },
  { family: 'SB Sans Text', style: 'Regular', count: 118, missing: false },
  { family: 'SB Sans Text', style: 'Italic', count: 6, missing: false },
  { family: 'Inter', style: 'Medium', count: 9, missing: false },
  { family: 'Montserrat', style: 'Black', count: 3, missing: false },
  { family: 'Gilroy', style: 'ExtraBold', count: 2, missing: true },
];

/** Extraction report entries that make the report scene representative. */
function demoReport(slideIds, slideNames) {
  const r = (i, level, code, nodeName, nodeType, message, reasons) => ({
    level,
    code,
    slideId: slideIds[i],
    slideName: slideNames[i],
    nodeId: `9:${i}${nodeName.length}`,
    nodeName,
    nodeType,
    message,
    ...(reasons ? { reasons } : {}),
  });
  return [
    r(0, 'raster', 'rasterized', 'Hero gradient blob', 'ELLIPSE', '"Hero gradient blob" was rasterized (gradient fill, blur).', ['gradient', 'blur']),
    r(0, 'raster', 'rasterized', 'Play icon', 'VECTOR', '"Play icon" was rasterized (vector shape).', ['vector']),
    r(0, 'raster', 'rasterized', 'Card / glass', 'FRAME', '"Card / glass" was rasterized (blend mode).', ['blend-mode', 'effects']),
    r(1, 'raster', 'rasterized', 'Logo mark', 'BOOLEAN_OPERATION', '"Logo mark" was rasterized (boolean operation).', ['boolean-operation']),
    r(1, 'raster', 'rasterized', 'Photo mask', 'GROUP', '"Photo mask" was rasterized (mask).', ['mask']),
    r(3, 'raster', 'rasterized', 'Chart line', 'VECTOR', '"Chart line" was rasterized (vector shape).', ['vector']),
    r(3, 'skipped', 'outside-clip', 'List item 14', 'TEXT', '"List item 14" is outside the slide or its clipping frame and was skipped.'),
    r(3, 'skipped', 'outside-clip', 'List item 15', 'TEXT', '"List item 15" is outside the slide or its clipping frame and was skipped.'),
    r(4, 'warning', 'missing-font', 'Caption', 'TEXT', '"Caption" uses a font missing in Figma (Gilroy ExtraBold); the text box may not match.'),
  ];
}

async function loadFixtures() {
  const names = ['kitchen-sink', 'mixed-sizes', 'diploma'];
  const slides = [];
  const assets = {};
  for (const n of names) {
    const deck = JSON.parse(await readFile(resolve(root, `tests/fixtures/${n}.ir.json`), 'utf8'));
    slides.push(...deck.slides);
    Object.assign(assets, deck.assets);
  }
  return { slides, assets };
}

// ─── In-page helpers ─────────────────────────────────────────────────────────

const INIT_SCRIPT = `
  window.__sent = [];
  // Top-level page: parent === window, so the UI's parent.postMessage lands here. Only plugin
  // messages are captured; everything else (JSZip's setImmediate polyfill uses postMessage) passes.
  const originalPostMessage = window.postMessage.bind(window);
  window.postMessage = function (data, ...rest) {
    if (data && typeof data === 'object' && 'pluginMessage' in data) window.__sent.push(data.pluginMessage);
    else originalPostMessage(data, ...rest);
  };
  window.__inject = function (msg) { window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: msg } })); };
  window.__b64 = function (s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
`;

/** Draws a fake slide into a canvas and returns PNG bytes (runs in the page). */
async function renderSlidePng(page, slide, width) {
  return page.evaluate(
    async ({ slide, width }) => {
      const h = Math.round((width * slide.height) / slide.width);
      const c = document.createElement('canvas');
      c.width = width;
      c.height = h;
      const g = c.getContext('2d');
      const s = width / slide.width; // px per frame px
      const font = (weight, size) => `${weight} ${Math.round(size * s)}px "DejaVu Sans", Arial, sans-serif`;
      const text = (str, x, y, weight, size, color) => {
        g.fillStyle = color;
        g.font = font(weight, size);
        g.fillText(str, x * s, y * s);
      };
      const rr = (x, y, w, hh, r, fill) => {
        g.fillStyle = fill;
        g.beginPath();
        g.roundRect(x * s, y * s, w * s, hh * s, r * s);
        g.fill();
      };
      if (slide.art === 'poster') {
        const bg = g.createLinearGradient(0, 0, width, h);
        bg.addColorStop(0, '#1b0b6b');
        bg.addColorStop(0.55, '#3a1fd1');
        bg.addColorStop(1, '#1a1060');
        g.fillStyle = bg;
        g.fillRect(0, 0, width, h);
        for (let i = 0; i < 3; i++) {
          const rad = g.createRadialGradient((700 + i * 120) * s, (300 + i * 380) * s, 0, (700 + i * 120) * s, (300 + i * 380) * s, 520 * s);
          rad.addColorStop(0, 'rgba(160,120,255,0.55)');
          rad.addColorStop(1, 'rgba(160,120,255,0)');
          g.fillStyle = rad;
          g.fillRect(0, 0, width, h);
        }
        text('Технологическая премия', 560, 120, 700, 44, '#fff');
        text('Взрывной', 110, 520, 700, 150, '#fff');
        text('рост', 110, 680, 700, 150, '#fff');
        text('Диплом за стремительный рывок и вклад в будущее', 110, 780, 400, 30, 'rgba(255,255,255,0.85)');
        text('Победитель', 110, 960, 700, 52, '#fff');
        text('Алексей Катков', 110, 1260, 700, 30, '#fff');
        text('Наталья Сергунина', 460, 1260, 700, 30, '#fff');
        text('2026', 860, 1340, 400, 40, 'rgba(255,255,255,0.7)');
      } else if (slide.art === 'title') {
        const bg = g.createLinearGradient(0, 0, width, h);
        bg.addColorStop(0, '#0f172a');
        bg.addColorStop(1, '#1e3a8a');
        g.fillStyle = bg;
        g.fillRect(0, 0, width, h);
        rr(1180, 160, 580, 760, 48, 'rgba(56,189,248,0.18)');
        rr(1260, 240, 420, 420, 210, 'rgba(56,189,248,0.55)');
        text('STARTUP', 140, 420, 800, 150, '#fff');
        text('SUMMIT 2026', 140, 580, 800, 150, '#38bdf8');
        text('Moscow · 14–16 October', 140, 700, 400, 48, 'rgba(255,255,255,0.75)');
      } else if (slide.art === 'agenda') {
        g.fillStyle = '#f4f1ea';
        g.fillRect(0, 0, width, h);
        text('Agenda', 140, 230, 800, 110, '#111');
        const items = ['Opening keynote', 'Founders panel', 'Demo day', 'Investor meetings', 'Awards'];
        items.forEach((it, i) => {
          rr(140, 330 + i * 130, 90, 90, 45, i === 2 ? '#ff5b2e' : '#111');
          text(String(i + 1), 172, 392 + i * 130, 700, 44, '#fff');
          text(it, 280, 392 + i * 130, 500, 56, '#111');
        });
        rr(1200, 330, 580, 610, 36, '#ff5b2e');
      } else if (slide.art === 'chart') {
        g.fillStyle = '#111318';
        g.fillRect(0, 0, width, h);
        text('Growth metrics', 140, 200, 800, 96, '#fff');
        const bars = [220, 340, 300, 480, 560, 720];
        bars.forEach((v, i) => rr(160 + i * 200, 960 - v, 130, v, 16, i === bars.length - 1 ? '#22c55e' : '#3b82f6'));
        text('+214%', 1440, 420, 800, 140, '#22c55e');
        text('ARR year over year', 1440, 500, 400, 40, 'rgba(255,255,255,0.7)');
      } else {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, width, h);
        text('Team', 140, 220, 800, 110, '#111');
        const colors = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899'];
        colors.forEach((col, i) => {
          rr(150 + i * 420, 360, 300, 300, 150, col);
          text(['Anna', 'Boris', 'Carla', 'Dmitri'][i], 190 + i * 420, 760, 700, 56, '#111');
          text('Co-founder', 190 + i * 420, 830, 400, 36, '#666');
        });
      }
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { slide, width },
  );
}

async function inject(page, msg) {
  await page.evaluate((m) => window.__inject(m), msg);
}

/** Inject a message whose binary field `key` is given as a number array. */
async function injectBytes(page, msg, key, bytes) {
  await page.evaluate(
    ({ m, key, bytes }) => window.__inject({ ...m, [key]: new Uint8Array(bytes) }),
    { m: msg, key, bytes },
  );
}

async function shot(page, name) {
  const file = join(outDir, `${name}${suffix}.png`);
  await page.waitForTimeout(250); // let animations settle
  await page.screenshot({ path: file });
  console.log(`saved ${file}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const tmp = await mkdtemp(join(tmpdir(), 'fd-ui-'));
const htmlPath = join(tmp, 'ui.html');
await writeFile(htmlPath, await buildUiHtml());
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: findChromium() });
try {
  const context = await browser.newContext({
    viewport: WINDOW,
    deviceScaleFactor: 1,
    locale: lang === 'ru' ? 'ru-RU' : 'en-US',
    colorScheme: theme === 'light' ? 'light' : 'dark',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate((light) => {
    document.documentElement.classList.add(light ? 'figma-light' : 'figma-dark');
  }, theme === 'light');

  // 1. Empty state
  await inject(page, { type: 'init', slides: [], settings: SETTINGS, deckTitle: 'Startup Summit - 2026', fileName: 'Startup Summit - 2026', selection: { frameCount: 0, alreadyInDeck: 0 } });
  await page.waitForSelector('.empty');
  await shot(page, 'empty');

  // 2. Deck view with thumbnails and a preview
  const slides = SLIDES.map(({ art, ...s }) => s);
  await inject(page, { type: 'init', slides, settings: SETTINGS, deckTitle: 'Startup Summit - 2026', fileName: 'Startup Summit - 2026', selection: { frameCount: 2, alreadyInDeck: 0 } });
  await page.waitForSelector('.slide-row');
  for (const s of SLIDES.filter((x) => !x.missing)) {
    await injectBytes(page, { type: 'thumbnail', id: s.id }, 'bytes', await renderSlidePng(page, s, 320));
  }
  await page.waitForTimeout(200);
  await injectBytes(page, { type: 'preview', id: SLIDES[0].id }, 'bytes', await renderSlidePng(page, SLIDES[0], 1400));
  await page.waitForFunction(() => {
    const img = document.querySelector('.stage-img');
    return img && img.complete && img.naturalWidth > 0 && !document.querySelector('.stage-loading');
  });
  await page.hover('.slide-row:nth-child(3)');
  await shot(page, 'deck');

  // 2a. Drag in progress (drop indicator + ghost), then Escape cancels it
  const rowCenter = async (n) => {
    const box = await page.locator(`.slide-row:nth-child(${n}) .slide-thumb`).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const from = await rowCenter(2);
  const to = await rowCenter(4);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y - 12, { steps: 8 });
  await page.waitForSelector('.drop-indicator');
  await shot(page, 'drag');
  await page.keyboard.press('Escape');
  await page.mouse.up();

  // 2b. Export menu
  await page.click('.split-toggle');
  await page.waitForSelector('.menu');
  await shot(page, 'export-menu');
  await page.keyboard.press('Escape');

  // 3. Settings drawer (+ font mapping scrolled into view)
  await page.click('.topbar-actions .btn:first-child');
  await page.waitForSelector('.drawer');
  await inject(page, { type: 'fonts', fonts: FONTS });
  await page.waitForSelector('.font-row');
  await shot(page, 'settings');
  await page.evaluate(() => {
    const body = document.querySelector('.drawer-body');
    body.scrollTop = body.scrollHeight;
  });
  await shot(page, 'settings-fonts');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached' });

  // 4. Progress overlay (real Exporter run started from the UI)
  await page.click('.split-main');
  await page.waitForFunction(() => window.__sent.some((m) => m && m.type === 'start-export'));
  const fx = await loadFixtures();
  await inject(page, { type: 'export-started', format: 'pptx', total: fx.slides.length });
  await inject(page, { type: 'export-progress', phase: 'extract', done: 2, total: fx.slides.length, label: `${fx.slides[2].name} — exporting 3/7` });
  await page.waitForSelector('.progress-dialog');
  await shot(page, 'progress');

  // 5. Finish the run with IR fixtures → images → buildPptx (in the browser) → download → report
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.evaluate(
    ({ slides, assets }) => {
      const decoded = Object.values(assets).map((a) => ({ ...a, data: window.__b64(a.data) }));
      slides.forEach((slide, index) => {
        window.__inject({ type: 'export-slide', index, total: slides.length, slide, assets: index === 0 ? decoded : [] });
      });
    },
    { slides: fx.slides, assets: fx.assets },
  );
  const ids = fx.slides.map((s) => s.id);
  const names = fx.slides.map((s) => s.name);
  await inject(page, {
    type: 'export-extracted',
    meta: { title: 'Startup Summit - 2026', author: 'Anna Petrova', company: 'Startup Summit', sourceFile: 'Startup Summit - 2026' },
    report: demoReport(ids, names),
  });
  const download = await downloadPromise.catch(async (e) => {
    const state = await page.evaluate(() => `${document.querySelector('.toasts')?.textContent} | ${document.querySelector('.progress-dialog')?.textContent}`);
    throw new Error(`No download (${state}): ${e.message}`);
  });
  const pptxPath = join(tmp, download.suggestedFilename());
  await download.saveAs(pptxPath);
  const pptx = await readFile(pptxPath);
  if (pptx[0] !== 0x50 || pptx[1] !== 0x4b) throw new Error('Downloaded file is not a ZIP package');
  console.log(`downloaded ${download.suggestedFilename()} (${pptx.length} bytes)`);
  await page.waitForSelector('.report-dialog');
  await shot(page, 'report');
  await page.evaluate(() => {
    const body = document.querySelector('.report-body');
    body.querySelector('details')?.removeAttribute('open'); // fold "Fonts" to show the other sections
    body.querySelectorAll('details').forEach((d, i) => i > 0 && d.setAttribute('open', ''));
    body.scrollTop = 0;
  });
  await shot(page, 'report-details');

  // 6. Interaction checks: drag-and-drop reorder, keyboard selection and removal
  await page.keyboard.press('Escape');
  await page.waitForSelector('.report-dialog', { state: 'detached' });
  const sentOf = (type) => page.evaluate((t) => window.__sent.filter((m) => m && m.type === t), type);
  if ((await sentOf('reorder-slides')).length !== 0) throw new Error('A cancelled drag sent reorder-slides');
  const a = await rowCenter(1);
  const b = await rowCenter(3);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y + 12, { steps: 8 });
  await page.mouse.up();
  const reorder = await sentOf('reorder-slides');
  const expected = ['1:11', '1:12', '1:10', '1:13', '1:14', '1:15'];
  if (JSON.stringify(reorder[0]?.ids) !== JSON.stringify(expected)) throw new Error(`Unexpected reorder: ${JSON.stringify(reorder)}`);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const previews = await sentOf('request-preview');
  if (previews[previews.length - 1]?.id !== '1:13') throw new Error(`ArrowDown selected ${previews[previews.length - 1]?.id}`);
  await page.keyboard.press('Delete');
  const removed = await sentOf('remove-slides');
  if (JSON.stringify(removed[0]?.ids) !== '["1:13"]') throw new Error(`Unexpected removal: ${JSON.stringify(removed)}`);
  console.log('interaction checks passed (drag reorder, ↓ selection, Delete)');

  const sent = await page.evaluate(() => window.__sent.map((m) => m && m.type));
  console.log(`UI → main: ${[...new Set(sent)].join(', ')}`);
  if (errors.length > 0) {
    console.error('Page errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  }
  await context.close();
} finally {
  await browser.close();
  await rm(tmp, { recursive: true, force: true });
}
