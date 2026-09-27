/**
 * Root component: wires the main-thread bridge, deck state, images, keyboard, settings persistence
 * and the export pipeline to the views (empty state / deck view + dialogs).
 *
 * - Language: Settings → General → Language (`auto` / `en` / `ru`), applied on the next render.
 * - `init.command === 'settings'` (Figma menu "Settings") opens the settings drawer.
 * - Nothing waits forever: the start-up spinner turns into "Can't connect" + retry
 *   (CONFIG.ui.bootTimeoutMs), the preview / fonts spinners and the thumbnail shimmer stop after
 *   their timeouts, "Cancel" always closes the export overlay (Exporter), unexpected errors become
 *   one-line toasts (the error boundary in main.tsx catches render errors).
 */
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { buildPptx } from '../../build/index';
import { CONFIG } from '../../config';
import type { MainToUi } from '../../shared/messages';
import { DEFAULT_SETTINGS, type ExportFormat, type ExportSettings } from '../../shared/settings';
import { ObjectUrlCache, listen, send } from '../bridge';
import { createCompressor } from '../compressor';
import { copyText, downloadBytes } from '../download';
import { cleanErrorMessage } from '../errors';
import { loadDevTools, saveDevTools } from '../dev-tools';
import { Exporter, type ExporterEvent } from '../exporter';
import { getLang, resolveLang, setLang, t, toastText, tp } from '../i18n';
import { processAssets } from '../images';
import { imageDeckToPdf, mergePdfs } from '../pdf';
import type { ProgressState } from '../progress';
import { moveItem } from '../reorder';
import { buildReportModel, reportToText, type ExportOutcome } from '../report';
import { INITIAL_STATE, deckReducer, effectiveTitle, exportableCount, newFramesInSelection } from '../state';
import { Modal, Spinner } from './controls';
import { EmptyState } from './EmptyState';
import { StatusScreen } from './ErrorBoundary';
import { Preview } from './Preview';
import { ProgressOverlay } from './ProgressOverlay';
import { ReportDialog } from './ReportDialog';
import { ResizeGrip } from './ResizeGrip';
import { SettingsPanel } from './SettingsPanel';
import { Sidebar } from './Sidebar';
import { Toasts, useToasts } from './Toasts';
import { TopBar } from './TopBar';

/** Keyboard shortcuts are ignored while the user types. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Chromium reports this benign layout notice as a window error: not worth a toast. */
function isBenignError(message: string): boolean {
  return /ResizeObserver loop/i.test(message);
}

function ConfirmClear(props: { count: number; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  return (
    <Modal title={t('clear.title')} class="confirm-dialog" onClose={props.onCancel}>
      <div class="confirm-body">
        <p>{tp('clear.text', props.count)}</p>
        <p class="muted">{t('clear.note')}</p>
      </div>
      <footer class="dialog-foot">
        <span class="spacer" />
        <button type="button" class="btn" onClick={props.onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" class="btn danger" onClick={props.onConfirm}>
          {t('clear.confirm')}
        </button>
      </footer>
    </Modal>
  );
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(deckReducer, INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Interface language: every t() call below (and in the children) uses it.
  const lang = resolveLang(state.settings.language);
  if (getLang() !== lang) setLang(lang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const thumbCache = useMemo(() => new ObjectUrlCache(), []);
  const previewCache = useMemo(() => new ObjectUrlCache(), []);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  /** Slides whose preview main could not render (id → error text, may be empty). */
  const [failedPreviews, setFailedPreviews] = useState<Record<string, string>>({});
  const requestedThumbs = useRef(new Set<string>());
  /** Slides whose thumbnail never came (no thumbnail at all for CONFIG.ui.thumbnailStallMs). */
  const [failedThumbs, setFailedThumbs] = useState<Record<string, true>>({});
  const thumbWatch = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [bootFailed, setBootFailed] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devTools, setDevToolsState] = useState(() => loadDevTools());
  const setDevTools = useCallback((on: boolean) => {
    setDevToolsState(on);
    saveDevTools(on);
  }, []);
  const [confirmClear, setConfirmClear] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const { toasts, push: toast, dismiss } = useToasts();
  const settingsDirty = useRef(false);

  // ─── Export pipeline ───────────────────────────────────────────────────────
  /** One compression worker for the session (started on the first export that compresses an image). */
  const compressor = useMemo(() => createCompressor(), []);
  useEffect(() => () => compressor.dispose(), [compressor]);
  const onExportEvent = useRef<(e: ExporterEvent) => void>(() => undefined);
  onExportEvent.current = (e: ExporterEvent) => {
    switch (e.type) {
      case 'progress':
        setProgress(e.progress);
        break;
      case 'done':
        setProgress(null);
        setOutcome(e.outcome);
        break;
      case 'cancelled':
        setProgress(null);
        toast(() => t('error.cancelled'));
        break;
      case 'error': {
        setProgress(null);
        const message = e.message;
        toast(() => (message ? t('error.export', { message }) : t('error.exportUnknown')), true);
        break;
      }
    }
  };
  const exporter = useMemo(
    () =>
      new Exporter(
        {
          send,
          buildPptx,
          processAssets: (assets, options, hooks) => processAssets(assets, options, hooks, undefined, compressor),
          mergePdfs,
          imageDeckToPdf,
          download: downloadBytes,
          now: () => performance.now(),
          setTimeout: (fn, ms) => window.setTimeout(fn, ms),
          clearTimeout: (handle) => window.clearTimeout(handle as number),
        },
        (e) => onExportEvent.current(e),
      ),
    [],
  );

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    send({ type: 'request-fonts' });
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  /**
   * (Re)start the thumbnail watchdog: when no thumbnail arrives for CONFIG.ui.thumbnailStallMs, the
   * slides still without one stop their loading shimmer (main skips frames it cannot export).
   */
  const armThumbWatch = useCallback(() => {
    if (thumbWatch.current) clearTimeout(thumbWatch.current);
    thumbWatch.current = setTimeout(() => {
      thumbWatch.current = null;
      const pending = stateRef.current.slides.filter((s) => !s.missing && !thumbCache.get(s.id)).map((s) => s.id);
      if (pending.length === 0) return;
      setFailedThumbs((prev) => {
        const next = { ...prev };
        for (const id of pending) next[id] = true;
        return next;
      });
    }, CONFIG.ui.thumbnailStallMs);
  }, []);
  useEffect(
    () => () => {
      if (thumbWatch.current) clearTimeout(thumbWatch.current);
    },
    [],
  );

  // ─── Messages from main ────────────────────────────────────────────────────
  useEffect(() => {
    const inDeck = (id: string) => stateRef.current.slides.some((s) => s.id === id);
    const off = listen((msg: MainToUi) => {
      if (exporter.handle(msg)) return;
      switch (msg.type) {
        case 'thumbnail':
          if (!inDeck(msg.id)) return; // removed while its thumbnail was being rendered
          thumbCache.set(msg.id, msg.bytes);
          setThumbs(thumbCache.snapshot());
          setFailedThumbs((prev) => withoutKey(prev, msg.id));
          if (stateRef.current.slides.some((s) => !s.missing && !thumbCache.get(s.id))) armThumbWatch();
          else if (thumbWatch.current) clearTimeout(thumbWatch.current);
          return;
        case 'preview':
          if (!inDeck(msg.id)) return;
          previewCache.set(msg.id, msg.bytes);
          setPreviews(previewCache.snapshot());
          setFailedPreviews((prev) => withoutKey(prev, msg.id));
          setLoadingPreview((current) => (current === msg.id ? null : current));
          return;
        case 'preview-failed':
          // Stop the spinner right away (instead of waiting for CONFIG.ui.previewTimeoutMs).
          if (!inDeck(msg.id)) return;
          setFailedPreviews((prev) => ({ ...prev, [msg.id]: msg.message ?? '' }));
          setLoadingPreview((current) => (current === msg.id ? null : current));
          return;
        case 'toast':
          // Localized from its code (re-evaluated on a language switch); main's English text otherwise.
          toast(() => toastText(msg), !!msg.error);
          return;
        case 'init':
          setBootFailed(false);
          if (msg.command === 'settings') openSettings();
          dispatch({ type: 'main', msg });
          return;
        default:
          dispatch({ type: 'main', msg });
      }
    });
    send({ type: 'ui-ready' });
    return () => {
      off();
      thumbCache.clear();
      previewCache.clear();
    };
  }, []);

  // ─── Thumbnails: request new ones, drop removed ones ──────────────────────
  useEffect(() => {
    const ids = state.slides.map((s) => s.id);
    if (thumbCache.retain(ids)) setThumbs(thumbCache.snapshot());
    if (previewCache.retain(ids)) setPreviews(previewCache.snapshot());
    const alive = new Set(ids);
    for (const id of [...requestedThumbs.current]) if (!alive.has(id)) requestedThumbs.current.delete(id);
    const need = state.slides.filter((s) => !s.missing && !requestedThumbs.current.has(s.id)).map((s) => s.id);
    if (need.length > 0) {
      for (const id of need) requestedThumbs.current.add(id);
      send({ type: 'request-thumbnails', ids: need });
      armThumbWatch();
    }
  }, [state.slides]);

  // ─── Start-up: no `init` from main → "Can't connect" with a retry ─────────
  useEffect(() => {
    if (state.ready) return;
    const timer = setTimeout(() => setBootFailed(true), CONFIG.ui.bootTimeoutMs);
    return () => clearTimeout(timer);
  }, [state.ready, bootAttempt]);
  const retryBoot = useCallback(() => {
    setBootFailed(false);
    setBootAttempt((n) => n + 1);
    send({ type: 'ui-ready' });
  }, []);

  // ─── Unexpected errors (async code, event handlers): one readable line, never a stack ──
  useEffect(() => {
    const report = (reason: unknown) => {
      const message = cleanErrorMessage(reason);
      if (isBenignError(message)) return;
      console.error(reason);
      toast(() => (message ? t('toast.error', { message }) : t('crash.title')), true);
    };
    const onRejection = (e: PromiseRejectionEvent) => report(e.reason);
    const onError = (e: ErrorEvent) => report(e.error ?? e.message);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  // Coming back from the canvas: frames may have changed (no document change events with dynamic-page).
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      const now = Date.now();
      if (now - last < CONFIG.ui.thumbnailRefreshMinIntervalMs) return;
      last = now;
      const st = stateRef.current;
      const ids = st.slides.filter((s) => !s.missing).map((s) => s.id);
      if (ids.length > 0) send({ type: 'request-thumbnails', ids });
      if (st.selectedId && ids.includes(st.selectedId)) send({ type: 'request-preview', id: st.selectedId });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // ─── Preview of the selected slide ─────────────────────────────────────────
  const selectedIndex = state.slides.findIndex((s) => s.id === state.selectedId);
  const selected = selectedIndex >= 0 ? state.slides[selectedIndex] : null;
  const selectedMissing = !!selected?.missing;
  useEffect(() => {
    const id = state.selectedId;
    if (!id || selectedMissing || !stateRef.current.slides.some((s) => s.id === id)) {
      setLoadingPreview(null);
      return;
    }
    setLoadingPreview(id);
    setFailedPreviews((prev) => withoutKey(prev, id)); // retried on every selection
    const request = setTimeout(() => send({ type: 'request-preview', id }), CONFIG.ui.previewRequestDelayMs);
    const giveUp = setTimeout(() => {
      // No answer at all: stop the spinner and say so (unless an earlier preview is still shown).
      setLoadingPreview((current) => (current === id ? null : current));
      if (!previewCache.get(id)) setFailedPreviews((prev) => (id in prev ? prev : { ...prev, [id]: '' }));
    }, CONFIG.ui.previewTimeoutMs);
    return () => {
      clearTimeout(request);
      clearTimeout(giveUp);
    };
  }, [state.selectedId, selectedMissing]);

  // ─── Settings persistence (debounced) ──────────────────────────────────────
  const updateSettings = useCallback((patch: Partial<ExportSettings>) => {
    settingsDirty.current = true;
    dispatch({ type: 'settings', patch });
  }, []);
  useEffect(() => {
    if (!settingsDirty.current) return;
    const timer = setTimeout(() => {
      settingsDirty.current = false;
      send({ type: 'save-settings', settings: state.settings });
    }, CONFIG.ui.settingsSaveDebounceMs);
    return () => clearTimeout(timer);
  }, [state.settings]);

  const resetSettings = useCallback(() => {
    // Keep the font mapping and document properties (content, not preferences) and the language.
    const s = stateRef.current.settings;
    settingsDirty.current = true;
    dispatch({
      type: 'replace-settings',
      settings: { ...DEFAULT_SETTINGS, language: s.language, fontOverrides: s.fontOverrides, author: s.author, company: s.company },
    });
  }, []);

  // Settings → Fonts: main answers `fonts` (an empty list on failure); if nothing comes, stop the spinner.
  const fontsPending = settingsOpen && state.fonts === null;
  useEffect(() => {
    setFontsTimedOut(false);
    if (!fontsPending) return;
    const timer = setTimeout(() => setFontsTimedOut(true), CONFIG.ui.fontsTimeoutMs);
    return () => clearTimeout(timer);
  }, [fontsPending]);

  // ─── Deck actions ──────────────────────────────────────────────────────────
  const removeSlide = useCallback((id: string) => {
    dispatch({ type: 'remove', ids: [id] });
    send({ type: 'remove-slides', ids: [id] });
  }, []);

  const moveSlide = useCallback((from: number, insertBefore: number) => {
    const ids = moveItem(
      stateRef.current.slides.map((s) => s.id),
      from,
      insertBefore,
    );
    dispatch({ type: 'move', from, insertBefore });
    send({ type: 'reorder-slides', ids });
  }, []);

  const clearAll = useCallback(() => {
    setConfirmClear(false);
    dispatch({ type: 'remove', ids: stateRef.current.slides.map((s) => s.id) });
    send({ type: 'clear-slides' });
  }, []);

  const setTitle = useCallback((title: string) => {
    dispatch({ type: 'title', title });
    send({ type: 'set-deck-title', title });
  }, []);

  const focusSlide = useCallback((id: string) => send({ type: 'focus-slide', id }), []);
  const addSlides = useCallback(() => send({ type: 'add-selection' }), []);

  const startExport = useCallback(
    (format: ExportFormat) => {
      const st = stateRef.current;
      if (exportableCount(st.slides) === 0) {
        toast(() => t('export.noSlides'), true);
        return;
      }
      setOutcome(null);
      const names = st.slides.filter((s) => !s.missing).map((s) => s.name);
      if (!exporter.start(format, st.settings, effectiveTitle(st), names)) toast(() => t('error.busy'), true);
    },
    [exporter],
  );

  // ─── Keyboard: ↑/↓ select, Delete/Backspace remove ─────────────────────────
  const blocking = settingsOpen || confirmClear || !!progress || !!outcome;
  const blockingRef = useRef(blocking);
  blockingRef.current = blocking;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || blockingRef.current || isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          e.preventDefault();
          dispatch({ type: 'select-offset', delta: e.key === 'ArrowDown' ? 1 : -1 });
          break;
        case 'Home':
        case 'End':
          e.preventDefault();
          dispatch({ type: 'select-offset', delta: e.key === 'End' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER });
          break;
        case 'Delete':
        case 'Backspace': {
          const id = stateRef.current.selectedId;
          if (id) {
            e.preventDefault();
            removeSlide(id);
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeSlide]);

  // ─── Report actions ────────────────────────────────────────────────────────
  const downloadAgain = useCallback(() => {
    if (outcome) downloadBytes(outcome.data, outcome.fileName, outcome.mime);
  }, [outcome]);
  const copyReport = useCallback(async () => {
    if (!outcome) return;
    let copied = false;
    try {
      copied = await copyText(reportToText(outcome, buildReportModel(outcome.entries, outcome.fonts, outcome.slideIds)));
    } catch {
      copied = false;
    }
    toast(() => (copied ? t('report.copied') : t('report.copyFailed')), !copied);
  }, [outcome]);

  // ─── View ──────────────────────────────────────────────────────────────────
  const exportFrames = useMemo(() => state.slides.filter((s) => !s.missing).map((s) => ({ width: s.width, height: s.height })), [state.slides]);
  const newFrames = newFramesInSelection(state.selection);
  const allInDeck = state.selection.frameCount > 0 && newFrames === 0;
  const addHint = allInDeck ? t('empty.hintAllInDeck') : t('empty.hintNoFrames');

  let body: JSX.Element;
  if (!state.ready) {
    body = bootFailed ? (
      <StatusScreen title={t('boot.timeoutTitle')} text={t('boot.timeoutText')} onRetry={retryBoot} />
    ) : (
      <div class="boot">
        <Spinner size={24} label={t('common.loading')} />
      </div>
    );
  } else if (state.slides.length === 0) {
    body = <EmptyState newFrames={newFrames} allInDeck={allInDeck} onAdd={addSlides} onSettings={openSettings} />;
  } else {
    body = (
      <div class="deck">
        <Sidebar
          slides={state.slides}
          selectedId={state.selectedId}
          thumbs={thumbs}
          failedThumbs={failedThumbs}
          addLabel={newFrames > 0 ? tp('add.buttonSidebarN', newFrames) : t('add.buttonSidebar')}
          addDisabled={newFrames === 0}
          addHint={addHint}
          onSelect={(id) => dispatch({ type: 'select', id })}
          onFocus={focusSlide}
          onRemove={removeSlide}
          onMove={moveSlide}
          onSort={() => send({ type: 'sort-slides' })}
          onAdd={addSlides}
        />
        <main class="main">
          <TopBar
            title={state.deckTitle}
            placeholder={state.fileName || t('top.titlePlaceholder')}
            canExport={exportableCount(state.slides) > 0 && !progress}
            mode={state.settings.mode}
            devTools={devTools}
            onTitle={setTitle}
            onSettings={openSettings}
            onClear={() => setConfirmClear(true)}
            onExport={startExport}
          />
          <Preview
            slide={selected}
            index={selectedIndex}
            total={state.slides.length}
            url={selected ? (previews[selected.id] ?? thumbs[selected.id]) : undefined}
            loading={!!selected && loadingPreview === selected.id}
            failed={selected ? (failedPreviews[selected.id] ?? null) : null}
            onFocus={focusSlide}
          />
        </main>
      </div>
    );
  }

  return (
    <div class="app">
      {body}
      {settingsOpen ? (
        <SettingsPanel
          settings={state.settings}
          fonts={state.fonts}
          fontsFailed={fontsTimedOut && state.fonts === null}
          devTools={devTools}
          onDevTools={setDevTools}
          frames={exportFrames}
          onChange={updateSettings}
          onReset={resetSettings}
          onClose={closeSettings}
        />
      ) : null}
      {confirmClear ? <ConfirmClear count={state.slides.length} onConfirm={clearAll} onCancel={() => setConfirmClear(false)} /> : null}
      {progress ? <ProgressOverlay progress={progress} onCancel={() => exporter.cancel()} /> : null}
      {outcome ? <ReportDialog outcome={outcome} onClose={() => setOutcome(null)} onDownloadAgain={downloadAgain} onCopy={copyReport} /> : null}
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <ResizeGrip send={send} />
    </div>
  );
}
