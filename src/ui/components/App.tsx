/**
 * Root component: wires the main-thread bridge, deck state, images, keyboard, settings persistence
 * and the export pipeline to the views (empty state / deck view + dialogs).
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
import { Exporter, type ExporterEvent } from '../exporter';
import { t, tp } from '../i18n';
import { processAssets } from '../images';
import { imageDeckToPdf, mergePdfs } from '../pdf';
import type { ProgressState } from '../progress';
import { moveItem } from '../reorder';
import { buildReportModel, reportToText, type ExportOutcome } from '../report';
import { INITIAL_STATE, deckReducer, effectiveTitle, exportableCount, newFramesInSelection } from '../state';
import { Modal, Spinner } from './controls';
import { EmptyState } from './EmptyState';
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

  const thumbCache = useMemo(() => new ObjectUrlCache(), []);
  const previewCache = useMemo(() => new ObjectUrlCache(), []);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  /** Slides whose preview main could not render (id → error text, may be empty). */
  const [failedPreviews, setFailedPreviews] = useState<Record<string, string>>({});
  const requestedThumbs = useRef(new Set<string>());

  const [settingsOpen, setSettingsOpen] = useState(false);
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
        toast(t('error.cancelled'));
        break;
      case 'error':
        setProgress(null);
        toast(t('error.export', { message: e.message }), true);
        break;
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
          toast(msg.message, !!msg.error);
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
    }
  }, [state.slides]);

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
    const giveUp = setTimeout(() => setLoadingPreview((current) => (current === id ? null : current)), CONFIG.ui.previewTimeoutMs);
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
    // Keep the font mapping and document properties: they are content, not preferences.
    const s = stateRef.current.settings;
    settingsDirty.current = true;
    dispatch({ type: 'replace-settings', settings: { ...DEFAULT_SETTINGS, fontOverrides: s.fontOverrides, author: s.author, company: s.company } });
  }, []);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    send({ type: 'request-fonts' });
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

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
        toast(t('export.noSlides'), true);
        return;
      }
      setOutcome(null);
      const names = st.slides.filter((s) => !s.missing).map((s) => s.name);
      if (!exporter.start(format, st.settings, effectiveTitle(st), names)) toast(t('error.busy'), true);
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
    const text = reportToText(outcome, buildReportModel(outcome.entries, outcome.fonts, outcome.slideIds));
    toast((await copyText(text)) ? t('report.copied') : t('report.copyFailed'), false);
  }, [outcome]);

  // ─── View ──────────────────────────────────────────────────────────────────
  const exportFrames = useMemo(() => state.slides.filter((s) => !s.missing).map((s) => ({ width: s.width, height: s.height })), [state.slides]);
  const newFrames = newFramesInSelection(state.selection);
  const allInDeck = state.selection.frameCount > 0 && newFrames === 0;
  const addHint = allInDeck ? t('empty.hintAllInDeck') : t('empty.hintNoFrames');

  let body: JSX.Element;
  if (!state.ready) {
    body = (
      <div class="boot">
        <Spinner size={24} label={t('common.loading')} />
      </div>
    );
  } else if (state.slides.length === 0) {
    body = <EmptyState newFrames={newFrames} allInDeck={allInDeck} onAdd={addSlides} />;
  } else {
    body = (
      <div class="deck">
        <Sidebar
          slides={state.slides}
          selectedId={state.selectedId}
          thumbs={thumbs}
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
        <SettingsPanel settings={state.settings} fonts={state.fonts} frames={exportFrames} onChange={updateSettings} onReset={resetSettings} onClose={closeSettings} />
      ) : null}
      {confirmClear ? <ConfirmClear count={state.slides.length} onConfirm={clearAll} onCancel={() => setConfirmClear(false)} /> : null}
      {progress ? <ProgressOverlay progress={progress} onCancel={() => exporter.cancel()} /> : null}
      {outcome ? <ReportDialog outcome={outcome} onClose={() => setOutcome(null)} onDownloadAgain={downloadAgain} onCopy={copyReport} /> : null}
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <ResizeGrip send={send} />
    </div>
  );
}
