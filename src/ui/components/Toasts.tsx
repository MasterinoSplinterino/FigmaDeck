/**
 * Toast stack (bottom center): info toasts fade out after CONFIG.ui.toastMs, errors after
 * CONFIG.ui.errorToastMs; click to dismiss. A toast may be given as a function: it is re-evaluated on
 * every render, so a toast still on screen follows a language switch.
 */
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { CONFIG } from '../../config';
import { t } from '../i18n';
import { IconClose, IconWarning } from './icons';

export type ToastContent = string | (() => string);

export interface Toast {
  id: number;
  content: ToastContent;
  error: boolean;
}

function textOf(content: ToastContent): string {
  return typeof content === 'function' ? content() : content;
}

export function useToasts(): { toasts: Toast[]; push: (content: ToastContent, error?: boolean) => void; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (content: ToastContent, error = false) => {
      const id = nextId.current++;
      const text = textOf(content);
      // The same text again replaces the older toast (a repeated click does not stack copies).
      setToasts((list) => [...list.filter((x) => textOf(x.content) !== text), { id, content, error }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), error ? CONFIG.ui.errorToastMs : CONFIG.ui.toastMs),
      );
    },
    [dismiss],
  );

  useEffect(() => () => timers.current.forEach((timer) => clearTimeout(timer)), []);
  return { toasts, push, dismiss };
}

export function Toasts(props: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element {
  return (
    <div class="toasts" aria-live="polite">
      {props.toasts.map((toast) => (
        <div key={toast.id} class={toast.error ? 'toast error' : 'toast'} role={toast.error ? 'alert' : 'status'}>
          {toast.error ? <IconWarning size={14} /> : null}
          <span class="toast-text">{textOf(toast.content)}</span>
          <button type="button" class="toast-close" aria-label={t('common.close')} onClick={() => props.onDismiss(toast.id)}>
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
