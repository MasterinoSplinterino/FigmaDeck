/**
 * Left sidebar: "Slides" header with count and sort button, numbered thumbnails (select, remove,
 * pointer-driven drag-and-drop reorder with a drop indicator and auto-scroll), "Add Slides" button.
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CONFIG } from '../../config';
import type { SlideInfo } from '../../shared/messages';
import { t } from '../i18n';
import { autoScrollDelta, insertionIndexAt, isNoopMove, type RowExtent } from '../reorder';
import { IconClose, IconPlus, IconSort, IconWarning } from './icons';

/** Thumbnail box size (px) in the list: fixed width, height from the aspect ratio, clamped. */
export function thumbSize(width: number, height: number): { w: number; h: number } {
  const W = CONFIG.ui.listThumbWidthPx;
  const maxH = CONFIG.ui.listThumbMaxHeightPx;
  if (!(width > 0 && height > 0)) return { w: W, h: Math.round((W * 9) / 16) };
  let w = W;
  let h = (W * height) / width;
  if (h > maxH) {
    h = maxH;
    w = (maxH * width) / height;
  }
  return { w: Math.round(w), h: Math.round(Math.max(CONFIG.ui.listThumbMinHeightPx, h)) };
}

export interface SidebarProps {
  slides: SlideInfo[];
  selectedId: string | null;
  thumbs: Record<string, string>;
  addLabel: string;
  addDisabled: boolean;
  addHint?: string;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (from: number, insertBefore: number) => void;
  onSort: () => void;
  onAdd: () => void;
}

/** What the drag renders. */
interface DragView {
  from: number;
  insert: number;
  /** Drop indicator top, px in list content coordinates. */
  indicatorTop: number;
  /** Pointer, viewport px. */
  x: number;
  y: number;
}

interface DragTrack {
  from: number;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  insert: number;
  frame: number;
}

interface DragController {
  begin(e: PointerEvent, index: number): void;
  end(commit: boolean): void;
}

/**
 * Window-level pointer tracking for one drag at a time. Created once per sidebar, so the listeners
 * added on pointerdown are exactly the ones removed on pointerup.
 */
function createDragController(
  listRef: { current: HTMLDivElement | null },
  onMoveRef: { current: (from: number, insertBefore: number) => void },
  setView: (v: DragView | null) => void,
): DragController {
  let track: DragTrack | null = null;

  const rows = (): HTMLElement[] => Array.from(listRef.current?.querySelectorAll<HTMLElement>('.slide-row') ?? []);

  const update = (d: DragTrack) => {
    const els = rows();
    const extents: RowExtent[] = els.map((r) => {
      const b = r.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    });
    d.insert = insertionIndexAt(extents, d.y);
    const last = els[els.length - 1];
    const indicatorTop = d.insert < els.length ? els[d.insert].offsetTop : last ? last.offsetTop + last.offsetHeight : 0;
    setView({ from: d.from, insert: d.insert, indicatorTop, x: d.x, y: d.y });
  };

  const tick = () => {
    const d = track;
    const list = listRef.current;
    if (!d || !d.active || !list) return;
    const r = list.getBoundingClientRect();
    const delta = autoScrollDelta(d.y, r.top, r.bottom, CONFIG.ui.dragAutoScrollZonePx, CONFIG.ui.dragAutoScrollMaxPx);
    if (delta !== 0) {
      const before = list.scrollTop;
      list.scrollTop += delta;
      if (list.scrollTop !== before) update(d);
    }
    d.frame = requestAnimationFrame(tick);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = track;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.active) {
      if (Math.hypot(d.x - d.startX, d.y - d.startY) < CONFIG.ui.dragThresholdPx) return;
      d.active = true;
      d.frame = requestAnimationFrame(tick);
    }
    e.preventDefault();
    update(d);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (track && e.pointerId === track.pointerId) end(true);
  };
  const onPointerCancel = () => end(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && track?.active) {
      e.preventDefault();
      e.stopPropagation();
      end(false);
    }
  };

  function end(commit: boolean): void {
    const d = track;
    track = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKey, true);
    if (!d) return;
    cancelAnimationFrame(d.frame);
    setView(null);
    if (commit && d.active && !isNoopMove(d.from, d.insert)) onMoveRef.current(d.from, d.insert);
  }

  return {
    begin(e, index) {
      end(false);
      track = { from: index, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false, insert: index, frame: 0 };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKey, true);
    },
    end,
  };
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const onMoveRef = useRef(props.onMove);
  onMoveRef.current = props.onMove;
  const [drag, setDrag] = useState<DragView | null>(null);
  const controller = useRef<DragController | null>(null);
  if (!controller.current) controller.current = createDragController(listRef, onMoveRef, setDrag);

  useEffect(() => () => controller.current?.end(false), []);

  // Keep the selected row visible (keyboard navigation, additions).
  useEffect(() => {
    if (!props.selectedId || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-id="${CSS.escape(props.selectedId)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [props.selectedId]);

  const onRowPointerDown = (e: PointerEvent, index: number, id: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.thumb-remove')) return;
    props.onSelect(id);
    controller.current?.begin(e, index);
  };

  const dragged = drag ? props.slides[drag.from] : null;
  const ghost = dragged ? thumbSize(dragged.width, dragged.height) : null;
  const ghostScale = CONFIG.ui.dragGhostScale;

  return (
    <aside class="sidebar">
      <header class="sidebar-head">
        <span class="sidebar-title">{t('sidebar.title')}</span>
        <span class="badge">{props.slides.length}</span>
        <span class="spacer" />
        <button type="button" class="icon-btn" title={t('sidebar.sort')} aria-label={t('sidebar.sort')} onClick={props.onSort} disabled={props.slides.length < 2}>
          <IconSort />
        </button>
      </header>

      <div class={drag ? 'slide-list dragging' : 'slide-list'} ref={listRef} role="listbox" aria-label={t('sidebar.title')}>
        {props.slides.map((s, i) => {
          const size = thumbSize(s.width, s.height);
          const selected = s.id === props.selectedId;
          const url = props.thumbs[s.id];
          const cls = ['slide-row', selected ? 'selected' : '', s.missing ? 'missing' : '', drag && drag.from === i ? 'drag-source' : ''].filter(Boolean).join(' ');
          return (
            <div
              key={s.id}
              class={cls}
              data-id={s.id}
              role="option"
              aria-selected={selected}
              title={
                s.missing
                  ? t('sidebar.missing')
                  : `${t('sidebar.slideTooltip', { name: s.name, w: Math.round(s.width), h: Math.round(s.height), page: s.pageName })}\n${t('sidebar.dragHint')}`
              }
              onPointerDown={(e) => onRowPointerDown(e, i, s.id)}
              onDblClick={() => !s.missing && props.onFocus(s.id)}
            >
              <span class="slide-num">{i + 1}</span>
              <div class="slide-thumb" style={{ width: `${size.w}px`, height: `${size.h}px` }}>
                {url ? <img src={url} alt="" draggable={false} /> : <span class={s.missing ? 'thumb-empty' : 'thumb-empty loading'} />}
                {s.missing ? (
                  <span class="thumb-warning" aria-label={t('sidebar.missing')}>
                    <IconWarning size={14} />
                  </span>
                ) : null}
                <button
                  type="button"
                  class="thumb-remove"
                  title={t('sidebar.remove')}
                  aria-label={t('sidebar.remove')}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onRemove(s.id);
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            </div>
          );
        })}
        {drag && !isNoopMove(drag.from, drag.insert) ? <div class="drop-indicator" style={{ top: `${drag.indicatorTop - 1}px` }} /> : null}
      </div>

      <footer class="sidebar-foot">
        <button type="button" class="btn outline block" onClick={props.onAdd} disabled={props.addDisabled} title={props.addDisabled ? props.addHint : undefined}>
          <IconPlus />
          <span class="btn-label">{props.addLabel}</span>
        </button>
      </footer>

      {drag && dragged && ghost ? (
        <div
          class="drag-ghost"
          style={{ left: `${drag.x + 10}px`, top: `${drag.y - (ghost.h * ghostScale) / 2}px`, width: `${ghost.w * ghostScale}px`, height: `${ghost.h * ghostScale}px` }}
        >
          {props.thumbs[dragged.id] ? <img src={props.thumbs[dragged.id]} alt="" draggable={false} /> : null}
        </div>
      ) : null}
    </aside>
  );
}
