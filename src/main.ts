/**
 * Plugin main thread (Figma sandbox): deck list, thumbnails, fonts, export orchestration.
 * Protocol: src/shared/messages.ts. Extraction: src/extract/.
 *
 * Export formats (`start-export`):
 * - `pptx`, `ir-json`: extraction with the user's mode (`editable` / `exact` / `image`);
 * - `pptx-image`, `pdf-image`: extraction in mode `image` (forced here whatever the settings say): one
 *   PNG per slide at `settings.rasterScale`; the UI re-encodes it (JPEG) and builds the file;
 * - `pdf`: Figma's own vector PDF per frame (`export-pdf-page`), merged by the UI.
 *
 * Figma menu (manifest.json `menu`, `figma.command`): `open` (default, also for an unknown / empty
 * command), `add-selection` (adds the selected frames, then shows the deck — or a toast when nothing
 * valid is selected) and `settings` (the UI opens its settings). The command reaches the UI with the
 * first `init`.
 *
 * Toasts carry a `code` (the UI shows its localized `toast.<code>` string); `message` is the English
 * fallback.
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

/** Commands of the manifest's `menu`. */
type LaunchCommand = 'open' | 'add-selection' | 'settings';

function launchCommand(raw: unknown): LaunchCommand {
  return raw === 'add-selection' || raw === 'settings' ? raw : 'open';
}

/** The command the plugin was started with, until the first `init` has delivered it to the UI. */
let pendingCommand: LaunchCommand | null = launchCommand(figma.command);

type ToastMsg = Extract<MainToUi, { type: 'toast' }>;
/** Codes of main's toasts (the UI's `toast.<code>` strings). */
type ToastCode = 'no-frames-selected' | 'already-in-deck' | 'slides-added' | 'frame-missing' | 'export-busy' | 'fonts-failed' | 'error';

function post(msg: MainToUi): void {
  figma.ui.postMessage(msg);
}

function toastMsg(code: ToastCode, message: string, error = false, params?: Record<string, string | number>): ToastMsg {
  const msg: ToastMsg = { type: 'toast', code, message, error };
  if (params) msg.params = params;
  return msg;
}

function toast(code: ToastCode, message: string, error = false, params?: Record<string, string | number>): void {
  post(toastMsg(code, message, error, params));
}

/** One readable line (no stack, no "Error:" prefix, bounded length) for toasts and export errors. */
function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^at\s/.test(l));
  const text = (line ?? '').replace(/^(?:[A-Z][A-Za-z]*)?Error:\s*/, '');
  const max = CONFIG.ui.errorMessageMaxChars;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || 'Unexpected error';
}

function unexpectedError(e: unknown): void {
  const message = errorMessage(e);
  toast('error', `Something went wrong: ${message}`, true, { message });
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
        // No known name: '' (the UI shows its localized "Missing frame").
        name: cached ? cached.name : '',
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

/** Persisted settings; unreadable storage counts as "nothing stored" (defaults). */
async function storedSettings(): Promise<unknown> {
  try {
    return await figma.clientStorage.getAsync(STORAGE_KEYS.settings);
  } catch {
    return undefined;
  }
}

/**
 * `ui-ready` → `init`. The launch command goes with the first `init` only (a UI that reloads gets
 * none); "Add selected frames" is applied before, so `init` already lists the new slides, and its
 * outcome follows as a toast.
 */
async function init(): Promise<void> {
  settings = normalizeSettings(await storedSettings());
  const command = pendingCommand;
  pendingCommand = null;
  let notice: ToastMsg | null = null;
  if (command === 'add-selection') {
    const result = await enqueueDeck(addSelectedFrames);
    notice =
      result.notice ??
      toastMsg('slides-added', `Added ${result.added} slide${result.added === 1 ? '' : 's'} to the deck.`, false, { n: result.added });
  }
  post({
    type: 'init',
    ...(command ? { command } : {}),
    slides: await slideInfos(),
    settings,
    deckTitle: deckTitle || figma.root.name,
    fileName: figma.root.name,
    selection: selectionInfo(),
  });
  if (notice) post(notice);
}

/**
 * Append the selected frames (sections expand, nested layers climb to their frame) that are not in
 * the deck yet, in canvas order. Returns how many were added, or the toast that explains why none was.
 */
async function addSelectedFrames(): Promise<{ added: number; notice: ToastMsg | null }> {
  const frames = framesFromSelection(figma.currentPage.selection);
  if (frames.length === 0) {
    return { added: 0, notice: toastMsg('no-frames-selected', 'Select frames (or a section) to add them as slides.', true) };
  }
  const fresh = frames.filter((f) => !deckIds.includes(f.id));
  if (fresh.length === 0) return { added: 0, notice: toastMsg('already-in-deck', 'The selected frames are already in the deck.') };
  const sorted = sortNodesByCanvas(fresh, figma.root.children);
  deckIds = [...deckIds, ...sorted.map((f) => f.id)];
  saveDeck();
  return { added: sorted.length, notice: null };
}

async function addSelection(): Promise<void> {
  const result = await addSelectedFrames();
  if (result.notice) {
    post(result.notice);
    return;
  }
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
  if (!node) {
    if (kind === 'preview') post({ type: 'preview-failed', id, message: 'This frame no longer exists.' });
    return;
  }
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
    toast('frame-missing', 'This frame no longer exists.', true);
    return;
  }
  const page = pageOf(node);
  if (!page) return;
  await ensurePageLoaded(page);
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  page.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

/** The deck's fonts; a failure still answers (an empty list) so the settings stop waiting. */
async function requestFonts(): Promise<void> {
  try {
    await sendFonts();
  } catch {
    post({ type: 'fonts', fonts: [] });
    toast('fonts-failed', 'Could not read the fonts used in the deck.', true);
  }
}

async function sendFonts(): Promise<void> {
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

/** A preview that cannot be produced still answers, so the UI stops waiting. */
async function requestPreview(id: string): Promise<void> {
  try {
    await exportImage(id, CONFIG.ui.previewWidth, 'preview');
  } catch (e) {
    post({ type: 'preview-failed', id, message: errorMessage(e) });
  }
}

/** Formats that are one baked picture per slide / page. */
function isImageFormat(format: ExportFormat): boolean {
  return format === 'pptx-image' || format === 'pdf-image';
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
    toast('export-busy', 'An export is already running.', true);
    return;
  }
  const s = normalizeSettings(rawSettings);
  if (isImageFormat(format)) {
    // One picture per slide whatever the UI sent; not persisted (the user's own mode stays).
    s.mode = 'image';
  } else {
    settings = s;
    figma.clientStorage.setAsync(STORAGE_KEYS.settings, s).catch(() => undefined);
  }
  const env = createFigmaEnv();
  const run = { cancelled: false, temp: new TempNodes(env) };
  exportRun = run;
  try {
    const { frames, missing } = await framesForExport();
    if (frames.length === 0) throw new Error('No slides to export: add frames to the deck first.');
    // The frames' pages are loaded now: remove what an earlier crashed run left there (this run has
    // not created any temporary node yet).
    for (const page of new Set(frames.map((f) => pageOf(f)))) if (page) removeLeftoversOn(page);
    post({ type: 'export-started', format, total: frames.length });
    const meta = deckMeta(s);
    if (format === 'pdf') {
      for (let i = 0; i < frames.length; i++) {
        if (run.cancelled) throw new ExtractCancelledError();
        post({ type: 'export-progress', phase: 'pdf', done: i, total: frames.length, label: frames[i].name, slide: i + 1 });
        const bytes = await frames[i].exportAsync({ format: 'PDF' });
        post({ type: 'export-pdf-page', index: i, total: frames.length, name: frames[i].name, bytes });
        await yieldToFigma();
      }
      post({ type: 'export-pdf-done', meta, report: missing });
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
        const lastJob = p.phase === 'export' && p.jobsDone === p.jobsTotal;
        if (now - lastProgress < CONFIG.extract.progressIntervalMs && p.nodesVisited > 0 && !lastJob) return;
        lastProgress = now;
        const what = p.phase === 'walk' ? `${p.nodesVisited} layers` : `exporting ${p.jobsDone}/${p.jobsTotal}`;
        post({
          type: 'export-progress',
          phase: 'extract',
          done: p.slideIndex,
          total: p.slideCount,
          label: `${frames[p.slideIndex]?.name ?? ''} — ${what}`,
          slide: p.slideIndex + 1,
          layers: p.nodesVisited,
          ...(p.phase === 'export' ? { jobsDone: p.jobsDone, jobsTotal: p.jobsTotal } : {}),
        });
      },
      // `e.assets` = assets new with this slide PLUS assets sent before that this slide displays larger
      // (same id, bigger displayWidth/Height — allowed by the protocol): the UI replaces them by id.
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
      await requestPreview(msg.id);
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

/**
 * Handlers that read-modify-write the deck list. They run one after another (`deckQueue`): e.g.
 * "sort by canvas" awaits one node lookup per slide and then writes the sorted list; an add / remove
 * handled in between would otherwise be overwritten by its stale snapshot (and persisted lost).
 * Everything else — exports above all, and `cancel-export`, which must reach a running export — is
 * handled immediately.
 */
const DECK_MESSAGES = new Set<UiToMain['type']>(['add-selection', 'remove-slides', 'clear-slides', 'reorder-slides', 'sort-slides']);
let deckQueue: Promise<void> = Promise.resolve();

function enqueueDeck<T>(task: () => Promise<T>): Promise<T> {
  const next = deckQueue.then(task, task);
  deckQueue = next.then(
    () => undefined,
    () => undefined, // a failed handler must not block the next ones
  );
  return next;
}

/**
 * Remove temporary composite nodes a crashed / closed run may have left behind. Clones land on the page
 * that was current during that run, so the current page (synchronously, before any message is handled)
 * and then the pages of the deck frames are scanned. Only loaded pages can be searched
 * (`dynamic-page`): a page that is not loaded throws and is skipped here — nothing is loaded just for
 * the cleanup — and is scanned when an export loads it. The deferred scan is skipped while an export
 * runs: its own temporary nodes carry the same marker (the export scans its pages itself).
 */
async function removeLeftovers(): Promise<void> {
  removeLeftoversOn(figma.currentPage);
  const pages = new Map<string, PageNode>();
  for (const id of deckIds) {
    const node = await resolveSlide(id);
    const page = node ? pageOf(node) : null;
    if (page) pages.set(page.id, page);
  }
  if (exportRun) return; // no await between this check and the scan
  for (const page of pages.values()) removeLeftoversOn(page);
}

function removeLeftoversOn(page: PageNode): void {
  try {
    const leftovers = page.findAllWithCriteria({ pluginData: { keys: [CONFIG.extract.tempPluginDataKey] } });
    for (const n of leftovers) if (!n.removed) n.remove();
  } catch {
    // Best effort (e.g. a page that is not loaded).
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

figma.showUI(__html__, {
  width: CONFIG.ui.windowWidth,
  height: CONFIG.ui.windowHeight,
  themeColors: true,
  title: CONFIG.meta.productName,
});

removeLeftovers().catch(() => undefined);

figma.ui.onmessage = (raw: unknown) => {
  const msg = raw as UiToMain;
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
  const done = DECK_MESSAGES.has(msg.type) ? enqueueDeck(() => handle(msg)) : handle(msg);
  done.catch((e) => {
    if (msg.type === 'start-export') post({ type: 'export-error', message: errorMessage(e) });
    else unexpectedError(e);
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
