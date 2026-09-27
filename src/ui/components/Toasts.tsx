/**
 * Toast stack (bottom center): info toasts fade out after CONFIG.ui.toastMs, errors after
 * CONFIG.ui.errorToastMs; click to dismiss.
 */
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { CONFIG } from '../../config';
import { t } from '../i18n';
import { IconClose, IconWarning } from './icons';

export interface Toast {
  id: number;
  message: string;
  error: boolean;
}

export function useToasts(): { toasts: Toast[]; push: (message: string, error?: boolean) => void; dismiss: (id: number) => void } {
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
    (message: string, error = false) => {
      const id = nextId.current++;
      setToasts((list) => [...list.filter((x) => x.message !== message), { id, message, error }]);
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
          <span class="toast-text">{toast.message}</span>
          <button type="button" class="toast-close" aria-label={t('common.close')} onClick={() => props.onDismiss(toast.id)}>
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
