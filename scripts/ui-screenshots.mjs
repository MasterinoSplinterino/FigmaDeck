// Renders the plugin UI standalone in headless Chromium and saves screenshots of its main states:
//   docs/screenshots/{empty,deck,drag,export-menu,settings,settings-compression,settings-fonts,progress,
//                     progress-images,report,report-details,report-pdf,settings-slide-size,preview-failed}
//                     [-light][-ru].png
//
// The UI is bundled with the options of scripts/build.mjs (imported from it: same esbuild options,
// Node-only modules stubbed, the compression worker injected, JS + CSS inlined into
// src/ui/index.html). `parent.postMessage` is stubbed (at top level `parent === window`) and
// main-thread messages are injected as window 'message' events. The report scene runs the real
// export pipeline (images → buildPptx in the browser) on IR fixtures plus a sample PNG, checks that
// image compression ran in the Web Worker (the main thread keeps painting meanwhile) and that the
// sample was stored as a smaller palette PNG in the downloaded .pptx; the vector PDF scene merges
// synthetic per-frame PDFs (the same photo in every frame, made with pdf-lib here) and checks that
// the duplicate image was stored once. The settings scene checks the image compression control;
// "Cancel" during a long compression must close the overlay at once (worker terminated, the next
// export uses a new one); with `Worker` refused (strict CSP) compression falls back to the main thread.
//
// Usage: npm run ui:screenshots -- [--theme dark|light] [--lang en|ru] [--out docs/screenshots] [--only deck,settings]
//   --only  save just these scenes (all scenes still run, so the interaction checks always happen)
import * as esbuild from 'esbuild';
import JSZip from 'jszip';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { PNG } from 'pngjs';
import { chromium } from 'playwright-core';
import { renderUiHtml, uiBuildOptions } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const theme = arg('theme', 'dark');
const lang = arg('lang', 'en');
const outDir = resolve(root, arg('out', 'docs/screenshots'));
const suffix = `${theme === 'light' ? '-light' : ''}${lang === 'ru' ? '-ru' : ''}`;
const only = arg('only', '') ? new Set(arg('only', '').split(',').map((x) => x.trim()).filter(Boolean)) : null;
const WINDOW = { width: 1000, height: 640 };

// ─── Bundle (the options of scripts/build.mjs, not minified) ─────────────────

async function buildUiHtml() {
  const result = await esbuild.build(uiBuildOptions({ minify: false, logLevel: 'warning' }));
  return renderUiHtml(result);
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

/** A deck of 4992×1536 LED-screen frames (the slide size scene). */
const LED_SLIDES = [
  { id: '2:1', name: lang === 'ru' ? 'LED — открытие' : 'LED — opening', width: 4992, height: 1536, pageId: '0:2', pageName: 'LED', art: 'led', title: 'STARTUP SUMMIT 2026' },
  { id: '2:2', name: lang === 'ru' ? 'LED — спикеры' : 'LED — speakers', width: 4992, height: 1536, pageId: '0:2', pageName: 'LED', art: 'led', title: lang === 'ru' ? 'СПИКЕРЫ' : 'SPEAKERS' },
  { id: '2:3', name: lang === 'ru' ? 'LED — партнёры' : 'LED — partners', width: 4992, height: 1536, pageId: '0:2', pageName: 'LED', art: 'led', title: lang === 'ru' ? 'ПАРТНЁРЫ' : 'PARTNERS' },
];

const SETTINGS = {
  mode: 'editable',
  rasterScale: 2,
  compression: 'balanced',
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
      if (slide.art === 'led') {
        const bg = g.createLinearGradient(0, 0, width, 0);
        bg.addColorStop(0, '#07091a');
        bg.addColorStop(0.5, '#1b1464');
        bg.addColorStop(1, '#07091a');
        g.fillStyle = bg;
        g.fillRect(0, 0, width, h);
        for (let i = 0; i < 5; i++) {
          const cx = (600 + i * 950) * s;
          const rad = g.createRadialGradient(cx, 760 * s, 0, cx, 760 * s, 620 * s);
          rad.addColorStop(0, i % 2 ? 'rgba(56,189,248,0.35)' : 'rgba(168,85,247,0.35)');
          rad.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = rad;
          g.fillRect(0, 0, width, h);
        }
        text(slide.title, 300, 900, 800, 420, '#fff');
        text('14–16.10 · Moscow', 320, 1180, 400, 120, 'rgba(255,255,255,0.7)');
      } else if (slide.art === 'poster') {
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
  if (only && !only.has(name)) return;
  const file = join(outDir, `${name}${suffix}.png`);
  await page.waitForTimeout(250); // let animations settle
  await page.screenshot({ path: file });
  console.log(`saved ${file}`);
}

/** A noisy opaque PNG (incompressible: it dominates the size of each frame PDF). */
function noisePng(width, height, seed) {
  const p = new PNG({ width, height });
  let x = seed;
  for (let i = 0; i < p.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      p.data[i + c] = 40 + ((x >>> 0) % 120);
    }
    p.data[i + 3] = 255;
  }
  return PNG.sync.write(p, { colorType: 2 });
}

/**
 * Sample for the image compression check: a soft semi-transparent card (diagonal gradient under a
 * radial alpha falloff, like a blurred Figma layer) with two antialiased discs. Thousands of colours,
 * so it takes the lossy palette path; about 1–3 s of work in the worker.
 */
const SAMPLE = { width: 1200, height: 750 };
/** A bigger one for the cancel check: its palette search takes seconds, cancelling must not wait for it. */
const BIG_SAMPLE = { width: 2400, height: 1500 };
function samplePng(w, h) {
  const p = new PNG({ width: w, height: h });
  const out = p.data;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.6;
  const discs = [
    { x: 0.3, y: 0.4, r: 0.12, c: [250, 250, 255] },
    { x: 0.62, y: 0.58, r: 0.09, c: [255, 200, 60] },
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      const d = Math.min(1, Math.hypot(x - cx, y - cy) / r);
      let a = (1 - d * d) ** 1.5;
      let cr = 40 + 180 * t;
      let cg = 60 + 60 * (1 - t);
      let cb = 200 - 90 * t;
      for (const s of discs) {
        const dist = Math.hypot(x + 0.5 - s.x * w, y + 0.5 - s.y * h) - s.r * h;
        let cov = dist < -1 ? 16 : 0;
        if (Math.abs(dist) <= 1) for (let k = 0; k < 16; k++) if (Math.hypot(x + ((k & 3) + 0.5) / 4 - s.x * w, y + ((k >> 2) + 0.5) / 4 - s.y * h) < s.r * h) cov++;
        const sa = cov / 16;
        if (sa === 0) continue;
        const na = sa + a * (1 - sa);
        cr = (s.c[0] * sa + cr * a * (1 - sa)) / na;
        cg = (s.c[1] * sa + cg * a * (1 - sa)) / na;
        cb = (s.c[2] * sa + cb * a * (1 - sa)) / na;
        a = na;
      }
      const A = Math.round(255 * a);
      const i = (y * w + x) * 4;
      if (A === 0) {
        out.fill(0, i, i + 4);
        continue;
      }
      out[i] = Math.round(cr);
      out[i + 1] = Math.round(cg);
      out[i + 2] = Math.round(cb);
      out[i + 3] = A;
    }
  }
  return PNG.sync.write(p);
}

/** Image compression summary of the open report dialog (its data-* attributes), or null. */
function reportImages(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.report-images');
    return el ? { thread: el.dataset.thread, before: Number(el.dataset.bytesBefore), after: Number(el.dataset.bytesAfter), methods: JSON.parse(el.dataset.methods), text: el.textContent } : null;
  });
}

/** Starts a one-slide PPTX export from the UI and feeds main's messages: `slide` + `assets` + the sample PNG. */
async function runSampleExport(page, slide, assets, sampleBytes, size) {
  const count = await page.evaluate(() => window.__sent.filter((m) => m && m.type === 'start-export').length);
  await page.click('.split-main');
  await page.waitForFunction((n) => window.__sent.filter((m) => m && m.type === 'start-export').length > n, count);
  await inject(page, { type: 'export-started', format: 'pptx', total: 1 });
  const all = { ...assets, sample: { id: 'sample', mime: 'image/png', role: 'raster', data: sampleBytes.toString('base64'), width: size.width, height: size.height, hasAlpha: true } };
  await page.evaluate(
    ({ slide, assets }) => {
      const decoded = Object.values(assets).map((a) => ({ ...a, data: window.__b64(a.data) }));
      window.__inject({ type: 'export-slide', index: 0, total: 1, slide, assets: decoded });
    },
    { slide, assets: all },
  );
  await inject(page, { type: 'export-extracted', meta: { title: 'Compression check' }, report: [] });
}

/** Regex source matching "W × H px" as the overlay prints it (en / ru digit grouping). */
function sizePattern(size) {
  const n = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '[,\\u00a0\\u202f ]?');
  return `${n(size.width)} × ${n(size.height)} px`;
}

/** PNG media of a .pptx with their IHDR (size, colour type). */
async function pptxPngs(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const out = [];
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/media\/.*\.png$/i.test(n))) {
    const data = await zip.file(name).async('uint8array');
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    out.push({ name, bytes: data.length, width: dv.getUint32(16), height: dv.getUint32(20), colorType: data[25] });
  }
  return out;
}

/** Per-frame PDFs like Figma's: the same background photo embedded in each, plus a title. */
async function framePdfs(slides) {
  const photo = noisePng(320, 180, 20260927);
  const out = [];
  for (const sl of slides) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([sl.width, sl.height]);
    const img = await doc.embedPng(photo);
    page.drawImage(img, { x: 0, y: 0, width: sl.width, height: sl.height });
    page.drawText(sl.name.replace(/[^\x20-\x7e]/g, '?'), { x: 80, y: sl.height - 160, size: 72, font: await doc.embedFont(StandardFonts.Helvetica) });
    out.push(await doc.save());
  }
  return out;
}

async function imageCount(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')).length;
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

  // 3a. Image compression control: three levels, the JPEG quality slider is disabled when Off.
  const levelCard = (v) => page.locator(`.compression-list .mode-card[data-value="${v}"]`);
  if ((await levelCard('balanced').getAttribute('aria-checked')) !== 'true') throw new Error('Balanced compression is not selected by default');
  await levelCard('strong').click();
  await levelCard('off').click();
  const qualitySlider = page.locator('.row', { has: page.locator('.slider') }).filter({ has: page.locator('.row-label', { hasText: /JPEG/ }) }).locator('input[type=range]');
  if (!(await qualitySlider.isDisabled())) throw new Error('JPEG quality slider is enabled while compression is Off');
  await page.waitForTimeout(600); // debounced save-settings
  const offSave = (await page.evaluate(() => window.__sent.filter((m) => m && m.type === 'save-settings'))).pop();
  if (offSave?.settings.compression !== 'off' || offSave.settings.jpeg !== false) throw new Error(`Compression Off not saved: ${JSON.stringify(offSave?.settings)}`);
  await levelCard('balanced').click();
  if (await qualitySlider.isDisabled()) throw new Error('JPEG quality slider stays disabled');
  await page.waitForTimeout(600);
  const balancedSave = (await page.evaluate(() => window.__sent.filter((m) => m && m.type === 'save-settings'))).pop();
  if (balancedSave?.settings.compression !== 'balanced' || balancedSave.settings.jpeg !== true) throw new Error(`Balanced compression not saved: ${JSON.stringify(balancedSave?.settings)}`);
  await page.evaluate(() => document.querySelector('.compression-list').closest('.section').scrollIntoView({ block: 'start' }));
  await shot(page, 'settings-compression');
  console.log('compression control checks passed (levels, slider disabled when Off, save-settings)');
  await page.evaluate(() => document.querySelector('.font-mapping').closest('.section').scrollIntoView({ block: 'start' }));
  await shot(page, 'settings-fonts');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached' });

  // 4. Progress overlay (real Exporter run started from the UI)
  await page.click('.split-main');
  await page.waitForFunction(() => window.__sent.some((m) => m && m.type === 'start-export'));
  const fx = await loadFixtures();
  await inject(page, { type: 'export-started', format: 'pptx', total: fx.slides.length });
  // Numeric progress fields: the overlay localizes "<slide name> — rasterizing 5 of 12" itself.
  await inject(page, { type: 'export-progress', phase: 'extract', done: 2, total: fx.slides.length, label: 'Agenda — exporting 5/12', slide: 3, layers: 1240, jobsDone: 5, jobsTotal: 12 });
  await page.waitForSelector('.progress-dialog');
  await shot(page, 'progress');

  // 5. Finish the run with IR fixtures + the sample PNG → images (compression worker) → buildPptx (in
  //    the browser) → download → report
  const sample = samplePng(SAMPLE.width, SAMPLE.height);
  const assets = {};
  for (const [id, a] of Object.entries(fx.assets)) {
    assets[id] = a;
    if (id === 'play-svg') assets.sample = { id: 'sample', mime: 'image/png', role: 'raster', data: sample.toString('base64'), width: SAMPLE.width, height: SAMPLE.height, hasAlpha: true };
  }
  fx.slides[0].elements.push({
    type: 'image',
    id: '9:sample',
    name: 'Glass card',
    transform: { x: 1180, y: 560, w: SAMPLE.width / 2, h: SAMPLE.height / 2, rotation: 0, flipH: false, flipV: false },
    opacity: 1,
    assetId: 'sample',
    svgAssetId: null,
    crop: null,
    geometry: 'rect',
    cornerRadius: 0,
    rasterized: { reasons: ['blur'] },
  });
  // Main-thread responsiveness while images are compressed: longest gap between animation frames.
  await page.evaluate(() => {
    const f = (window.__frames = { maxGap: 0, last: 0, frames: 0, on: true });
    const tick = (time) => {
      const phase = document.querySelector('.progress-phase')?.textContent ?? '';
      if (/Compressing images|Сжатие изображений/.test(phase)) {
        if (f.last) f.maxGap = Math.max(f.maxGap, time - f.last);
        f.last = time;
        f.frames++;
      } else f.last = 0;
      if (f.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.evaluate(
    ({ slides, assets }) => {
      const decoded = Object.values(assets).map((a) => ({ ...a, data: window.__b64(a.data) }));
      slides.forEach((slide, index) => {
        window.__inject({ type: 'export-slide', index, total: slides.length, slide, assets: index === 0 ? decoded : [] });
      });
    },
    { slides: fx.slides, assets },
  );
  const ids = fx.slides.map((s) => s.id);
  const names = fx.slides.map((s) => s.name);
  await inject(page, {
    type: 'export-extracted',
    meta: { title: 'Startup Summit - 2026', author: 'Anna Petrova', company: 'Startup Summit', sourceFile: 'Startup Summit - 2026' },
    report: demoReport(ids, names),
  });
  // "Compressing images i of N" with the sample's size while the worker works on it.
  await page
    .waitForFunction((src) => new RegExp(src).test(document.querySelector('.progress-detail')?.textContent ?? ''), sizePattern(SAMPLE), { timeout: 30000 })
    .then(() => shot(page, 'progress-images'))
    .catch(() => console.warn('warning: the images phase passed before it could be captured (progress-images not saved)'));
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
  const frames = await page.evaluate(() => {
    window.__frames.on = false;
    return window.__frames;
  });
  const imageStats = await reportImages(page);
  if (!imageStats) throw new Error('The report has no image compression summary');
  console.log(`image compression: ${imageStats.thread === 'worker' ? 'Web Worker' : imageStats.thread} path — ${imageStats.text}`);
  console.log(`main thread while compressing: ${frames.frames} frames, longest gap ${Math.round(frames.maxGap)} ms`);
  if (imageStats.thread !== 'worker') throw new Error(`Image compression did not run in the Web Worker (thread: ${imageStats.thread})`);
  if (!(imageStats.after < imageStats.before) || !(imageStats.methods['palette-lossy'] >= 1)) throw new Error(`Images were not compressed: ${JSON.stringify(imageStats)}`);
  if (frames.frames > 0 && frames.maxGap > 800) throw new Error(`The main thread stalled for ${Math.round(frames.maxGap)} ms while compressing`);
  const media = await pptxPngs(pptx);
  const packed = media.find((m) => m.width === SAMPLE.width && m.height === SAMPLE.height);
  if (!packed || packed.colorType !== 3 || packed.bytes >= sample.length) throw new Error(`Sample PNG not stored as a smaller palette PNG: ${JSON.stringify(packed)} (original ${sample.length} bytes)`);
  console.log(`sample PNG ${SAMPLE.width}×${SAMPLE.height}: ${sample.length} → ${packed.bytes} bytes (palette PNG, −${Math.round((1 - packed.bytes / sample.length) * 100)}%) in ${packed.name}`);
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

  // 6b. Cancel while a big image is being compressed: the worker is terminated at once (no waiting
  //     for the job); the next export compresses in a fresh worker.
  await runSampleExport(page, fx.slides[0], fx.assets, samplePng(BIG_SAMPLE.width, BIG_SAMPLE.height), BIG_SAMPLE);
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.progress-detail')?.textContent ?? ''), sizePattern(BIG_SAMPLE), { timeout: 30000 });
  const cancelStart = Date.now();
  await page.click('.progress-foot .btn');
  await page.waitForSelector('.progress-dialog', { state: 'detached', timeout: 10000 });
  const cancelMs = Date.now() - cancelStart;
  const toastText = await page.textContent('.toasts');
  if (!/Export cancelled|Экспорт отменён/.test(toastText ?? '')) throw new Error(`No "cancelled" toast after Cancel: ${toastText}`);
  if (cancelMs > 1000) throw new Error(`Cancel took ${cancelMs} ms during image compression (the worker job was not terminated)`);
  const again = page.waitForEvent('download', { timeout: 120000 });
  await runSampleExport(page, fx.slides[0], fx.assets, sample, SAMPLE);
  await (await again).path();
  await page.waitForSelector('.report-dialog');
  const rerun = await reportImages(page);
  if (rerun?.thread !== 'worker' || !(rerun.methods['palette-lossy'] >= 1)) throw new Error(`Export after a cancelled compression did not use a fresh worker: ${JSON.stringify(rerun)}`);
  console.log(`cancel during compression: overlay closed in ${cancelMs} ms (worker terminated); the next export compressed in a new worker`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.report-dialog', { state: 'detached' });

  // 7. Vector PDF: Figma's per-frame PDFs → merged, duplicate photo stored once → report
  await page.click('.split-toggle');
  await page.waitForSelector('.menu');
  const items = await page.$$eval('.menu-item .menu-label', (els) => els.map((e) => e.textContent));
  if (items.length !== 5) throw new Error(`Export menu has ${items.length} items: ${items.join(' | ')}`);
  await page.locator('.menu-item').nth(2).click(); // "PDF — vector"
  await page.waitForFunction(() => window.__sent.some((m) => m && m.type === 'start-export' && m.format === 'pdf'));
  const pdfSlides = SLIDES.filter((x) => !x.missing && x.id !== '1:13');
  const parts = await framePdfs(pdfSlides);
  const pdfDownload = page.waitForEvent('download', { timeout: 60000 });
  await inject(page, { type: 'export-started', format: 'pdf', total: parts.length });
  for (let i = 0; i < parts.length; i++) {
    await injectBytes(page, { type: 'export-pdf-page', index: i, total: parts.length, name: pdfSlides[i].name }, 'bytes', Array.from(parts[i]));
  }
  const missingName = SLIDES.find((x) => x.missing).name;
  await inject(page, {
    type: 'export-pdf-done',
    meta: { title: 'Startup Summit - 2026' },
    report: [{ level: 'warning', code: 'missing-frame', slideId: '1:15', slideName: missingName, message: `Frame "${missingName}" no longer exists and was skipped.` }],
  });
  const pdfFile = await pdfDownload;
  const pdfPath = join(tmp, pdfFile.suggestedFilename());
  await pdfFile.saveAs(pdfPath);
  const merged = await readFile(pdfPath);
  const partsTotal = parts.reduce((n, p) => n + p.length, 0);
  const images = await imageCount(merged);
  if (images !== 1) throw new Error(`Merged PDF has ${images} image XObjects (expected 1)`);
  console.log(`vector PDF: ${parts.length} frame PDFs, ${partsTotal} bytes → ${merged.length} bytes, ${images} image`);
  await page.waitForSelector('.report-dialog');
  await shot(page, 'report-pdf');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.report-dialog', { state: 'detached' });

  // 8. LED deck: slide size settings with the agency template preset (letterbox warning)
  const ledSlides = LED_SLIDES.map(({ art, title, ...x }) => x);
  await inject(page, { type: 'init', slides: ledSlides, settings: SETTINGS, deckTitle: 'Startup Summit LED', fileName: 'Startup Summit LED', selection: { frameCount: 0, alreadyInDeck: 0 } });
  await page.waitForFunction((n) => document.querySelectorAll('.slide-row').length === n, LED_SLIDES.length);
  for (const x of LED_SLIDES) await injectBytes(page, { type: 'thumbnail', id: x.id }, 'bytes', await renderSlidePng(page, x, 320));
  await page.click('.topbar-actions .btn:first-child');
  await page.waitForSelector('.drawer');
  await inject(page, { type: 'fonts', fonts: FONTS });
  await page.locator('.section', { has: page.locator('.preset-grid, .size-summary') }).locator('.segment').nth(3).click(); // "Custom"
  await page.waitForSelector('.preset-grid');
  await page.locator('.preset').nth(3).click(); // agency template
  await page.waitForSelector('.preset.active');
  const warning = await page.textContent('.size-summary + .callout');
  if (!warning || !/3[.,]24:1/.test(warning)) throw new Error(`No letterbox warning for the agency template: ${warning}`);
  await page.evaluate(() => document.querySelector('.preset-grid').closest('.section').scrollIntoView({ block: 'start' }));
  await shot(page, 'settings-slide-size');
  const saved = await sentOf('save-settings');
  await page.waitForTimeout(500); // debounced save-settings
  const lastSave = (await sentOf('save-settings')).pop();
  if (!lastSave || lastSave.settings.slideSizeMode !== 'custom' || Math.abs(lastSave.settings.slideWidthIn - 87.82 / 2.54) > 1e-9) {
    throw new Error(`Slide size not saved: ${JSON.stringify(lastSave?.settings)} (${saved.length} saves before)`);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached' });

  // 9. Preview that main could not render: the spinner stops, a badge stays over the thumbnail
  await page.locator('.slide-row').nth(1).click();
  await page.waitForFunction((id) => window.__sent.some((m) => m && m.type === 'request-preview' && m.id === id), LED_SLIDES[1].id);
  await inject(page, { type: 'preview-failed', id: LED_SLIDES[1].id, message: 'exportAsync failed' });
  await page.waitForSelector('.stage-badge');
  if (await page.$('.stage-loading')) throw new Error('Spinner still visible after preview-failed');
  await shot(page, 'preview-failed');

  const sent = await page.evaluate(() => window.__sent.map((m) => m && m.type));
  console.log(`UI → main: ${[...new Set(sent)].join(', ')}`);

  // 10. Web Workers refused (as a strict CSP in the plugin iframe would): the same export compresses
  //     on the main thread, and the report says so.
  const strict = await browser.newContext({ viewport: WINDOW, deviceScaleFactor: 1, locale: lang === 'ru' ? 'ru-RU' : 'en-US', acceptDownloads: true });
  const noWorker = await strict.newPage();
  noWorker.on('pageerror', (e) => errors.push(e.message));
  await noWorker.addInitScript(`${INIT_SCRIPT}\n  window.Worker = function () { throw new DOMException('Refused to create a worker (test)', 'SecurityError'); };`);
  await noWorker.goto(pathToFileURL(htmlPath).href);
  await inject(noWorker, { type: 'init', slides: SLIDES.map(({ art, ...x }) => x), settings: SETTINGS, deckTitle: 'No worker', fileName: 'No worker', selection: { frameCount: 0, alreadyInDeck: 0 } });
  await noWorker.waitForSelector('.slide-row');
  const fallbackDownload = noWorker.waitForEvent('download', { timeout: 120000 });
  await runSampleExport(noWorker, fx.slides[0], fx.assets, sample, SAMPLE);
  await (await fallbackDownload).path();
  await noWorker.waitForSelector('.report-dialog');
  const fallback = await reportImages(noWorker);
  const fallbackNote = await noWorker.textContent('.report-note.warn-text').catch(() => null);
  if (fallback?.thread !== 'main' || !(fallback.methods['palette-lossy'] >= 1) || !fallbackNote) {
    throw new Error(`Main-thread fallback failed: ${JSON.stringify(fallback)} / note: ${fallbackNote}`);
  }
  console.log(`no Web Worker: main-thread fallback path — ${fallback.text} | ${fallbackNote}`);
  await strict.close();
  if (errors.length > 0) {
    console.error('Page errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  }
  await context.close();
} finally {
  await browser.close();
  await rm(tmp, { recursive: true, force: true });
}
