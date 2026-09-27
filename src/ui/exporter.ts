/**
 * UI-side export pipeline. One run at a time:
 *
 *   start() → `start-export` → main: export-started → export-progress / export-slide… → export-extracted
 *     ir-json     → serializeDeck → "<title>.figmadeck.json"
 *     pptx(-image) → processAssets (images) → buildPptx → "<title>.pptx"
 *     pdf-image   → processAssets → imageDeckToPdf → "<title>.pdf"
 *   pdf: main → export-pdf-page… → export-pdf-done → mergePdfs (+ duplicate resources merged) → "<title>.pdf"
 *
 * Cancel: while main is working, `cancel-export` is sent and the run ends when main confirms
 * (`export-cancelled`, or after CONFIG.ui.cancelTimeoutMs); during UI-side phases the pipeline stops
 * at the next checkpoint (between images / slides / pages).
 *
 * All side effects are injected (`ExporterDeps`) so the whole flow runs in Node tests.
 */
import type { BuildPptx, BuildProgress, BuildResult } from '../build/api';
import { CONFIG } from '../config';
import { serializeDeck } from '../ir/serialize';
import { IR_VERSION, type Asset, type Deck, type DeckMeta, type ReportEntry, type Slide } from '../ir/types';
import type { MainToUi, UiToMain } from '../shared/messages';
import type { ExportFormat, ExportSettings } from '../shared/settings';
import { fileNameFor } from './download';
import { t } from './i18n';
import type { ImageOptions, ProcessHooks } from './images';
import { buildOptionsFromSettings, fileKindOf, settingsForFormat } from './options';
import type { ImagePdfResult, MergeResult, PdfHooks, PdfMeta } from './pdf';
import type { ProgressPhase, ProgressState } from './progress';
import type { ExportOutcome, ImageStats } from './report';

export interface ExporterDeps {
  send: (msg: UiToMain) => void;
  buildPptx: BuildPptx;
  processAssets: (assets: Record<string, Asset>, options: ImageOptions, hooks: ProcessHooks) => Promise<ImageStats>;
  mergePdfs: (parts: readonly Uint8Array[], meta: PdfMeta, hooks: PdfHooks) => Promise<MergeResult>;
  imageDeckToPdf: (deck: Deck, meta: PdfMeta, hooks: PdfHooks) => Promise<ImagePdfResult>;
  download: (data: Uint8Array, fileName: string, mime: string) => void;
  /** Monotonic clock, ms. */
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export type ExporterEvent =
  | { type: 'progress'; progress: ProgressState }
  | { type: 'done'; outcome: ExportOutcome }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

interface Run {
  format: ExportFormat;
  /** Settings sent with `start-export` (per-format adjusted). */
  settings: ExportSettings;
  /** Deck title for the file name and metadata ('' → main's meta.title). */
  title: string;
  /** Names of the exported slides in order (localized progress: "<name> — 120 layers"). */
  slideNames: readonly string[];
  startedAt: number;
  total: number;
  slides: Array<Slide | undefined>;
  assets: Record<string, Asset>;
  pdfPages: Array<Uint8Array | undefined>;
  /** Last progress sent (for re-emitting with `cancelling`). */
  progress: ProgressState;
  cancelled: boolean;
  /** main has finished; the UI is building the file. */
  local: boolean;
  cancelTimer: unknown;
}

/** Thrown at checkpoints after "Cancel" during UI-side phases. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelledError';
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

function isCancellation(e: unknown): boolean {
  return e instanceof Error && /Cancelled/.test(e.name);
}

type ProgressMsg = Extract<MainToUi, { type: 'export-progress' }>;

/**
 * Overlay state from main's `export-progress`. The numeric fields (slide, layers, jobs) are kept so the
 * overlay can localize the detail line; `label` (English) stays as the fallback.
 */
function progressFromMain(run: Run, msg: ProgressMsg, phase: ProgressPhase): ProgressState {
  const p: ProgressState = { format: run.format, phase, done: msg.done, total: msg.total, detail: msg.label, cancelling: run.cancelled };
  const numeric = msg.layers !== undefined || msg.jobsTotal !== undefined;
  if (msg.slide !== undefined) p.slide = msg.slide;
  if (numeric) {
    // Slide in progress: main's 1-based `slide`, else done + 1 (main reports the 0-based index as `done`).
    const name = run.slideNames[(msg.slide ?? msg.done + 1) - 1];
    if (name) p.slideName = name;
    if (msg.layers !== undefined) p.layers = msg.layers;
    if (msg.jobsDone !== undefined && msg.jobsTotal !== undefined) {
      p.jobsDone = msg.jobsDone;
      p.jobsTotal = msg.jobsTotal;
    }
  }
  return p;
}

export class Exporter {
  private run: Run | null = null;

  constructor(
    private readonly deps: ExporterDeps,
    private readonly emit: (event: ExporterEvent) => void,
  ) {}

  get busy(): boolean {
    return this.run !== null;
  }

  /**
   * Start an export. Returns false when one is already running. `slideNames` = names of the slides
   * main will export, in order (the deck without missing frames); used for the progress line only.
   */
  start(format: ExportFormat, settings: ExportSettings, title: string, slideNames: readonly string[] = []): boolean {
    if (this.run) return false;
    const effective = settingsForFormat(format, settings);
    this.run = {
      format,
      settings: effective,
      title: title.trim(),
      slideNames: [...slideNames],
      startedAt: this.deps.now(),
      total: 0,
      slides: [],
      assets: {},
      pdfPages: [],
      progress: { format, phase: 'starting', done: 0, total: 0 },
      cancelled: false,
      local: false,
      cancelTimer: null,
    };
    this.emit({ type: 'progress', progress: this.run.progress });
    this.deps.send({ type: 'start-export', format, settings: effective });
    return true;
  }

  cancel(): void {
    const run = this.run;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    this.progress(run, { ...run.progress, cancelling: true });
    if (run.local) return; // the local pipeline stops at its next checkpoint
    this.deps.send({ type: 'cancel-export' });
    run.cancelTimer = this.deps.setTimeout(() => {
      if (this.run === run) this.finish(run, { type: 'cancelled' });
    }, CONFIG.ui.cancelTimeoutMs);
  }

  /** Feed a main → UI message. Returns true when it belonged to the export flow. */
  handle(msg: MainToUi): boolean {
    const run = this.run;
    switch (msg.type) {
      case 'export-started':
        if (run && !run.local) {
          // main echoes the requested format; the UI keeps its own (it decides how to build the file).
          run.total = msg.total;
          run.slides = [];
          run.assets = {};
          run.pdfPages = [];
          const phase: ProgressPhase = run.format === 'pdf' ? 'pdf' : 'extract';
          this.progress(run, { format: run.format, phase, done: 0, total: msg.total, cancelling: run.cancelled });
        }
        return true;
      case 'export-progress':
        if (run && !run.local && msg.phase !== 'done') this.progress(run, progressFromMain(run, msg, msg.phase));
        return true;
      case 'export-slide':
        if (run && !run.local) {
          run.slides[msg.index] = msg.slide;
          for (const asset of msg.assets) run.assets[asset.id] = asset; // re-sent assets replace older copies
          run.total = msg.total;
          this.progress(run, { ...run.progress, phase: 'extract', done: msg.index + 1, total: msg.total });
        }
        return true;
      case 'export-pdf-page':
        if (run && !run.local) {
          run.pdfPages[msg.index] = msg.bytes;
          this.progress(run, { format: run.format, phase: 'pdf', done: msg.index + 1, total: msg.total, detail: msg.name, cancelling: run.cancelled });
        }
        return true;
      case 'export-extracted':
        if (run && !run.local) this.startLocal(run, () => this.finishIr(run, msg.meta, msg.report));
        return true;
      case 'export-pdf-done':
        // `report` is new in the protocol: tolerate an older main without it.
        if (run && !run.local) this.startLocal(run, () => this.finishPdf(run, msg.meta, msg.report ?? []));
        return true;
      case 'export-cancelled':
        if (run && !run.local) this.finish(run, { type: 'cancelled' });
        return true;
      case 'export-error':
        if (run && !run.local) this.finish(run, run.cancelled ? { type: 'cancelled' } : { type: 'error', message: msg.message });
        return true;
      default:
        return false;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private progress(run: Run, p: ProgressState): void {
    if (this.run !== run) return;
    run.progress = p;
    this.emit({ type: 'progress', progress: p });
  }

  private finish(run: Run, event: ExporterEvent): void {
    if (this.run !== run) return;
    if (run.cancelTimer !== null) this.deps.clearTimeout(run.cancelTimer);
    this.run = null;
    this.emit(event);
  }

  private checkpoint(run: Run): void {
    if (run.cancelled || this.run !== run) throw new ExportCancelledError();
  }

  private startLocal(run: Run, work: () => Promise<ExportOutcome>): void {
    if (run.cancelled) {
      // Cancel crossed main's completion message: nothing to build.
      this.finish(run, { type: 'cancelled' });
      return;
    }
    run.local = true;
    work().then(
      (outcome) => {
        if (this.run !== run) return;
        if (run.cancelled) {
          this.finish(run, { type: 'cancelled' });
          return;
        }
        try {
          this.deps.download(outcome.data, outcome.fileName, outcome.mime);
        } catch (e) {
          this.finish(run, { type: 'error', message: errorText(e) });
          return;
        }
        this.finish(run, { type: 'done', outcome });
      },
      (e: unknown) => {
        if (run.cancelled || isCancellation(e)) this.finish(run, { type: 'cancelled' });
        else this.finish(run, { type: 'error', message: errorText(e) });
      },
    );
  }

  private fileName(run: Run, meta: DeckMeta): { fileName: string; mime: string } {
    const kind = fileKindOf(run.format);
    return { fileName: fileNameFor(run.title || meta.title || '', kind.extension), mime: kind.mime };
  }

  private async processImages(run: Run): Promise<ImageStats> {
    const s = run.settings;
    return this.deps.processAssets(
      run.assets,
      { rasterScale: s.rasterScale, jpeg: s.jpeg, jpegQuality: s.jpegQuality },
      {
        isCancelled: () => run.cancelled,
        onProgress: (done, total) => this.progress(run, { format: run.format, phase: 'images', done, total, cancelling: run.cancelled }),
      },
    );
  }

  private async finishIr(run: Run, meta: DeckMeta, report: ReportEntry[]): Promise<ExportOutcome> {
    const slides = run.slides.filter((s): s is Slide => !!s);
    if (slides.length === 0) throw new Error(t('error.noSlides'));
    const title = run.title || meta.title;
    const deck: Deck = { irVersion: IR_VERSION, meta: { ...meta, title }, slides, assets: run.assets, report: [...report] };
    const { fileName, mime } = this.fileName(run, meta);
    const base = { format: run.format, fileName, mime, slideCount: slides.length, slideIds: slides.map((s) => s.id) };
    const pdfMeta: PdfMeta = { title, author: run.settings.author || meta.author, company: run.settings.company || meta.company };

    if (run.format === 'ir-json') {
      this.progress(run, { format: run.format, phase: 'serialize', done: 0, total: 1 });
      const data = new TextEncoder().encode(serializeDeck(deck));
      return { ...base, data, durationMs: this.deps.now() - run.startedAt, stats: null, fonts: [], entries: deck.report, images: null, pdfDedupe: null };
    }

    const images = await this.processImages(run);
    this.checkpoint(run);

    if (run.format === 'pdf-image') {
      const pdf = await this.deps.imageDeckToPdf(deck, pdfMeta, {
        isCancelled: () => run.cancelled,
        onProgress: (done, total) => this.progress(run, { format: run.format, phase: 'render', done, total, cancelling: run.cancelled }),
      });
      return { ...base, data: pdf.data, durationMs: this.deps.now() - run.startedAt, stats: null, fonts: [], entries: [...deck.report, ...pdf.report], images, pdfDedupe: null };
    }

    const options = buildOptionsFromSettings(run.settings, title);
    const onBuild = (p: BuildProgress) => {
      // Throwing from the progress callback aborts buildPptx at its next step.
      this.checkpoint(run);
      if (p.phase === 'slides') this.progress(run, { format: run.format, phase: 'build', done: p.done, total: p.total });
      else if (p.phase === 'package') this.progress(run, { format: run.format, phase: 'package', done: 0, total: 1 });
      else this.progress(run, { format: run.format, phase: 'package', done: p.done, total: p.total });
    };
    this.progress(run, { format: run.format, phase: 'build', done: 0, total: slides.length });
    const result: BuildResult = await this.deps.buildPptx(deck, options, onBuild);
    return {
      ...base,
      data: result.data,
      durationMs: this.deps.now() - run.startedAt,
      stats: result.stats,
      fonts: result.fonts,
      entries: [...deck.report, ...result.report],
      images,
      pdfDedupe: null,
    };
  }

  private async finishPdf(run: Run, meta: DeckMeta, report: ReportEntry[]): Promise<ExportOutcome> {
    const pages = run.pdfPages.filter((p): p is Uint8Array => !!p);
    if (pages.length === 0) throw new Error(t('error.noPages'));
    const title = run.title || meta.title;
    const merged = await this.deps.mergePdfs(pages, { title, author: run.settings.author || meta.author, company: run.settings.company || meta.company }, {
      isCancelled: () => run.cancelled,
      onProgress: (done, total) => this.progress(run, { format: run.format, phase: 'merge', done, total, cancelling: run.cancelled }),
    });
    const { fileName, mime } = this.fileName(run, meta);
    return {
      format: run.format,
      fileName,
      mime,
      data: merged.data,
      durationMs: this.deps.now() - run.startedAt,
      slideCount: pages.length,
      slideIds: [],
      stats: null,
      fonts: [],
      entries: [...report],
      images: null,
      pdfDedupe: merged.dedupe,
    };
  }
}
