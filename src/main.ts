/**
 * Plugin main thread (Figma sandbox): deck list, thumbnails, fonts, export orchestration.
 * Protocol: src/shared/messages.ts. Extraction: src/extract/.
 *
 * Sandbox constraints: `documentAccess: "dynamic-page"` → only async node access
 * (`getNodeByIdAsync`, `page.loadAsync()`, `setCurrentPageAsync`), no `documentchange`; no DOM,
 * no TextEncoder / atob / structuredClone / fetch.
 */
import { CONFIG } from './config';
import { createFigmaEnv, extractDeck, ExtractCancelledError, isCancelledError, TempNodes } from './extract';
import { pageOf } from './extract/node-props';
import {
  countFonts,
  framesFromSelection,
  isPermutation,
  isSlideNode,
  isVisibleWithin,
  parseSlideIds,
  serializeSlideIds,
  sortNodesByCanvas,
  STORAGE_KEYS,
  type SlideNode,
} from './extract/selection';
import type { DeckMeta, ReportEntry } from './ir/types';
import type { FontInfo, MainToUi, SelectionInfo, SlideInfo, UiToMain } from './shared/messages';
import { fontKey, normalizeSettings, type ExportFormat, type ExportSettings } from './shared/settings';

// ─── State ───────────────────────────────────────────────────────────────────

let deckIds: string[] = parseSlideIds(figma.root.getPluginData(STORAGE_KEYS.slides));
let deckTitle: string = figma.root.getPluginData(STORAGE_KEYS.title);
let settings: ExportSettings = normalizeSettings(undefined);
/** Last known info per slide id (names of frames that went missing stay readable). */
const infoCache = new Map<string, SlideInfo>();
const loadedPages = new Set<string>();
let availableFonts: Set<string> | null = null;
let exportRun: { cancelled: boolean; temp: TempNodes } | null = null;

function post(msg: MainToUi): void {
  figma.ui.postMessage(msg);
}

function toast(message: string, error = false): void {
  post({ type: 'toast', message, error });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const yieldToFigma = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ─── Nodes & pages ───────────────────────────────────────────────────────────

async function ensurePageLoaded(page: PageNode | null): Promise<void> {
  if (!page || loadedPages.has(page.id)) return;
  await page.loadAsync();
  loadedPages.add(page.id);
}

async function resolveSlide(id: string): Promise<SlideNode | null> {
  try {
    const node = await figma.getNodeByIdAsync(id);
    return isSlideNode(node) ? node : null;
  } catch {
    return null;
  }
}

function infoOf(node: SlideNode): SlideInfo {
  const page = pageOf(node);
  const info: SlideInfo = {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
    pageId: page ? page.id : '',
    pageName: page ? page.name : '',
  };
  infoCache.set(node.id, info);
  return info;
}

async function slideInfos(): Promise<SlideInfo[]> {
  const out: SlideInfo[] = [];
  for (const id of deckIds) {
    const node = await resolveSlide(id);
    if (node) out.push(infoOf(node));
    else {
      const cached = infoCache.get(id);
      out.push({
        id,
        name: cached ? cached.name : 'Missing frame',
        width: cached ? cached.width : 0,
        height: cached ? cached.height : 0,
        pageId: cached ? cached.pageId : '',
        pageName: cached ? cached.pageName : '',
        missing: true,
      });
    }
  }
  return out;
}

async function sendSlides(): Promise<void> {
  post({ type: 'slides', slides: await slideInfos() });
}

function saveDeck(): void {
  figma.root.setPluginData(STORAGE_KEYS.slides, serializeSlideIds(deckIds));
}

function selectionInfo(): SelectionInfo {
  const frames = framesFromSelection(figma.currentPage.selection);
  return { frameCount: frames.length, alreadyInDeck: frames.filter((f) => deckIds.includes(f.id)).length };
}

function sendSelection(): void {
  post({ type: 'selection', selection: selectionInfo() });
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  settings = normalizeSettings(await figma.clientStorage.getAsync(STORAGE_KEYS.settings));
  post({
    type: 'init',
    slides: await slideInfos(),
    settings,
    deckTitle: deckTitle || figma.root.name,
    fileName: figma.root.name,
    selection: selectionInfo(),
  });
}

async function addSelection(): Promise<void> {
  const frames = framesFromSelection(figma.currentPage.selection);
  if (frames.length === 0) {
    toast('Select frames (or a section) to add them as slides.', true);
    return;
  }
  const fresh = frames.filter((f) => !deckIds.includes(f.id));
  if (fresh.length === 0) {
    toast('The selected frames are already in the deck.');
    return;
  }
  const sorted = sortNodesByCanvas(fresh, figma.root.children);
  deckIds = [...deckIds, ...sorted.map((f) => f.id)];
  saveDeck();
  await sendSlides();
  sendSelection();
}

async function sortSlides(): Promise<void> {
  const existing: SlideNode[] = [];
  const missing: string[] = [];
  for (const id of deckIds) {
    const node = await resolveSlide(id);
    if (node) existing.push(node);
    else missing.push(id);
  }
  deckIds = [...sortNodesByCanvas(existing, figma.root.children).map((n) => n.id), ...missing];
  saveDeck();
  await sendSlides();
}

async function exportImage(id: string, width: number, kind: 'thumbnail' | 'preview'): Promise<void> {
  const node = await resolveSlide(id);
  if (!node) return;
  await ensurePageLoaded(pageOf(node));
  const target = kind === 'thumbnail' ? width : Math.min(width, Math.max(1, Math.round(node.width * 2)));
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: Math.max(1, Math.round(target)) } });
  post({ type: kind, id, bytes });
}

async function requestThumbnails(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await exportImage(id, CONFIG.ui.thumbnailWidth, 'thumbnail');
    } catch {
      // One broken frame must not stop the others.
    }
  }
}

async function focusSlide(id: string): Promise<void> {
  const node = await resolveSlide(id);
  if (!node) {
    toast('This frame no longer exists.', true);
    return;
  }
  const page = pageOf(node);
  if (!page) return;
  await ensurePageLoaded(page);
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  page.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

async function requestFonts(): Promise<void> {
  if (!availableFonts) {
    const list = await figma.listAvailableFontsAsync();
    availableFonts = new Set(list.map((f) => fontKey(f.fontName.family, f.fontName.style)));
  }
  const texts: TextNode[] = [];
  for (const id of deckIds) {
    const frame = await resolveSlide(id);
    if (!frame) continue;
    await ensurePageLoaded(pageOf(frame));
    for (const t of frame.findAllWithCriteria({ types: ['TEXT'] })) if (isVisibleWithin(t, frame)) texts.push(t);
    await yieldToFigma();
  }
  const fonts: FontInfo[] = countFonts(texts).map((f) => ({
    family: f.family,
    style: f.style,
    count: f.count,
    missing: !availableFonts!.has(fontKey(f.family, f.style)),
  }));
  post({ type: 'fonts', fonts });
}

function deckMeta(s: ExportSettings): DeckMeta {
  return {
    title: deckTitle || figma.root.name,
    author: s.author,
    company: s.company,
    sourceFile: figma.root.name,
    createdAt: new Date().toISOString(),
  };
}

/** Deck frames that still exist (pages loaded) + report warnings for the missing ones. */
async function framesForExport(): Promise<{ frames: SlideNode[]; missing: ReportEntry[] }> {
  const frames: SlideNode[] = [];
  const missing: ReportEntry[] = [];
  for (const id of deckIds) {
    const node = await resolveSlide(id);
    if (node) {
      await ensurePageLoaded(pageOf(node));
      frames.push(node);
    } else {
      const name = infoCache.get(id)?.name ?? id;
      missing.push({
        level: 'warning',
        code: 'missing-frame',
        slideId: id,
        slideName: name,
        message: `Frame "${name}" no longer exists and was skipped.`,
      });
    }
  }
  return { frames, missing };
}

async function startExport(format: ExportFormat, rawSettings: ExportSettings): Promise<void> {
  if (exportRun) {
    toast('An export is already running.', true);
    return;
  }
  const s = normalizeSettings(rawSettings);
  settings = s;
  figma.clientStorage.setAsync(STORAGE_KEYS.settings, s).catch(() => undefined);
  const env = createFigmaEnv();
  const run = { cancelled: false, temp: new TempNodes(env) };
  exportRun = run;
  try {
    const { frames, missing } = await framesForExport();
    if (frames.length === 0) throw new Error('No slides to export: add frames to the deck first.');
    post({ type: 'export-started', format, total: frames.length });
    const meta = deckMeta(s);
    if (format === 'pdf') {
      for (let i = 0; i < frames.length; i++) {
        if (run.cancelled) throw new ExtractCancelledError();
        post({ type: 'export-progress', phase: 'pdf', done: i, total: frames.length, label: frames[i].name });
        const bytes = await frames[i].exportAsync({ format: 'PDF' });
        post({ type: 'export-pdf-page', index: i, total: frames.length, name: frames[i].name, bytes });
        await yieldToFigma();
      }
      if (missing.length > 0) toast(`${missing.length} missing frame(s) were skipped.`, true);
      post({ type: 'export-pdf-done', meta });
      return;
    }
    let lastProgress = 0;
    const result = await extractDeck(frames, {
      settings: s,
      env,
      temp: run.temp,
      isCancelled: () => run.cancelled,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastProgress < CONFIG.extract.progressIntervalMs && p.nodesVisited > 0) return;
        lastProgress = now;
        const what = p.phase === 'walk' ? `${p.nodesVisited} layers` : `exporting ${p.jobsDone}/${p.jobsTotal}`;
        post({
          type: 'export-progress',
          phase: 'extract',
          done: p.slideIndex,
          total: p.slideCount,
          label: `${frames[p.slideIndex]?.name ?? ''} — ${what}`,
        });
      },
      onSlide: (e) => post({ type: 'export-slide', index: e.index, total: e.total, slide: e.slide, assets: e.assets }),
    });
    post({ type: 'export-extracted', meta, report: [...missing, ...result.report] });
  } catch (e) {
    run.temp.removeAll();
    if (run.cancelled || isCancelledError(e)) post({ type: 'export-cancelled' });
    else post({ type: 'export-error', message: errorMessage(e) });
  } finally {
    run.temp.removeAll();
    exportRun = null;
  }
}

async function handle(msg: UiToMain): Promise<void> {
  switch (msg.type) {
    case 'ui-ready':
      await init();
      break;
    case 'add-selection':
      await addSelection();
      break;
    case 'remove-slides': {
      const remove = new Set(msg.ids);
      deckIds = deckIds.filter((id) => !remove.has(id));
      saveDeck();
      await sendSlides();
      sendSelection();
      break;
    }
    case 'clear-slides':
      deckIds = [];
      saveDeck();
      await sendSlides();
      sendSelection();
      break;
    case 'reorder-slides':
      if (isPermutation(deckIds, msg.ids)) {
        deckIds = [...msg.ids];
        saveDeck();
      }
      await sendSlides();
      break;
    case 'sort-slides':
      await sortSlides();
      break;
    case 'set-deck-title':
      deckTitle = String(msg.title ?? '').trim();
      figma.root.setPluginData(STORAGE_KEYS.title, deckTitle);
      break;
    case 'request-thumbnails':
      await requestThumbnails(msg.ids);
      break;
    case 'request-preview':
      await exportImage(msg.id, CONFIG.ui.previewWidth, 'preview');
      break;
    case 'focus-slide':
      await focusSlide(msg.id);
      break;
    case 'request-fonts':
      await requestFonts();
      break;
    case 'save-settings':
      settings = normalizeSettings(msg.settings);
      await figma.clientStorage.setAsync(STORAGE_KEYS.settings, settings);
      break;
    case 'start-export':
      await startExport(msg.format, msg.settings);
      break;
    case 'cancel-export':
      if (exportRun) exportRun.cancelled = true;
      break;
    case 'resize':
      figma.ui.resize(
        Math.max(CONFIG.ui.minWidth, Math.round(Number(msg.width) || 0)),
        Math.max(CONFIG.ui.minHeight, Math.round(Number(msg.height) || 0)),
      );
      break;
    case 'notify':
      figma.notify(String(msg.message), { error: !!msg.error });
      break;
  }
}

/** Remove temporary composite nodes a crashed / closed run may have left on the current page. */
function removeLeftovers(): void {
  try {
    const leftovers = figma.currentPage.findAllWithCriteria({ pluginData: { keys: [CONFIG.extract.tempPluginDataKey] } });
    for (const n of leftovers) if (!n.removed) n.remove();
  } catch {
    // Best effort.
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

figma.showUI(__html__, {
  width: CONFIG.ui.windowWidth,
  height: CONFIG.ui.windowHeight,
  themeColors: true,
  title: 'FigmaDeck',
});

removeLeftovers();

figma.ui.onmessage = (raw: unknown) => {
  const msg = raw as UiToMain;
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
  handle(msg).catch((e) => {
    if (msg.type === 'start-export') post({ type: 'export-error', message: errorMessage(e) });
    else toast(errorMessage(e), true);
  });
};

figma.on('selectionchange', sendSelection);
figma.on('currentpagechange', sendSelection);
figma.on('close', () => {
  if (exportRun) {
    exportRun.cancelled = true;
    exportRun.temp.removeAll();
  }
});
