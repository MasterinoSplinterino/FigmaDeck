/**
 * Bottom-right grip: dragging it asks main to resize the plugin window (`resize`, throttled).
 * Figma clamps nothing itself, so the UI applies CONFIG.ui.minWidth / minHeight too.
 */
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { CONFIG } from '../../config';
import type { UiToMain } from '../../shared/messages';
import { t } from '../i18n';
import { IconGrip } from './icons';

/** New window size for a drag from (startW, startH) by (dx, dy), clamped to the minimum (px). */
export function resizedWindow(startW: number, startH: number, dx: number, dy: number): { width: number; height: number } {
  return {
    width: Math.max(CONFIG.ui.minWidth, Math.round(startW + dx)),
    height: Math.max(CONFIG.ui.minHeight, Math.round(startH + dy)),
  };
}

export function ResizeGrip(props: { send: (msg: UiToMain) => void }): JSX.Element {
  const drag = useRef<{ x: number; y: number; w: number; h: number; last: number; pending: ReturnType<typeof setTimeout> | null } | null>(null);

  const emit = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const size = resizedWindow(d.w, d.h, e.clientX - d.x, e.clientY - d.y);
    d.last = Date.now();
    props.send({ type: 'resize', width: size.width, height: size.height });
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const wait = CONFIG.ui.resizeThrottleMs - (Date.now() - d.last);
    if (d.pending) clearTimeout(d.pending);
    if (wait <= 0) {
      d.pending = null;
      emit(e);
    } else {
      // Trailing call so the final size is always sent.
      d.pending = setTimeout(() => emit(e), wait);
    }
  };

  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    if (d?.pending) clearTimeout(d.pending);
    if (d) emit(e);
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      class="resize-grip"
      title={t('window.resize')}
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, w: window.innerWidth, h: window.innerHeight, last: 0, pending: null };
      }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <IconGrip size={16} />
    </div>
  );
}
