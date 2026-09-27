/**
 * Small form controls in the Figma style: segmented control, switch, slider, labeled rows, modal.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../i18n';
import { IconClose } from './icons';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  title?: string;
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  wide?: boolean;
}): JSX.Element {
  return (
    <div class={props.wide ? 'segmented wide' : 'segmented'} role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          class={o.value === props.value ? 'segment active' : 'segment'}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; id?: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      aria-checked={props.checked}
      aria-label={props.label}
      class={props.checked ? 'switch on' : 'switch'}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-knob" />
    </button>
  );
}

/** Label + hint on the left, control on the right. */
export function Row(props: { label: string; hint?: string; children: ComponentChildren; stacked?: boolean; inactive?: boolean }): JSX.Element {
  const cls = ['row', props.stacked ? 'stacked' : '', props.inactive ? 'inactive' : ''].filter(Boolean).join(' ');
  return (
    <div class={cls}>
      <div class="row-text">
        <div class="row-label">{props.label}</div>
        {props.hint ? <div class="row-hint">{props.hint}</div> : null}
      </div>
      <div class="row-control">{props.children}</div>
    </div>
  );
}

export function Section(props: { title: string; children: ComponentChildren; aside?: ComponentChildren }): JSX.Element {
  return (
    <section class="section">
      <header class="section-head">
        <h3 class="section-title">{props.title}</h3>
        {props.aside ? <div class="section-aside">{props.aside}</div> : null}
      </header>
      <div class="section-body">{props.children}</div>
    </section>
  );
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div class={props.disabled ? 'slider disabled' : 'slider'}>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-label={props.label}
        onInput={(e) => props.onChange(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="slider-value">{props.format(props.value)}</span>
    </div>
  );
}

/**
 * Modal dialog with backdrop; Escape and backdrop click call `onClose` (unless `dismissible` is false).
 * Focus moves into the dialog when it opens.
 */
export function Modal(props: {
  title?: string;
  onClose?: () => void;
  children: ComponentChildren;
  class?: string;
  dismissible?: boolean;
  labelledBy?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const dismissible = props.dismissible !== false && !!props.onClose;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  // Focus once on open (not on every re-render, which would steal focus from the dialog's buttons).
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dismissible]);
  return (
    <div
      class="backdrop"
      onPointerDown={(e) => {
        if (dismissible && e.target === e.currentTarget) props.onClose?.();
      }}
    >
      <div class={`dialog ${props.class ?? ''}`} role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1} ref={ref}>
        {props.title !== undefined ? (
          <header class="dialog-head">
            <h2 class="dialog-title">{props.title}</h2>
            {dismissible ? (
              <button type="button" class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onClick={() => props.onClose?.()}>
                <IconClose />
              </button>
            ) : null}
          </header>
        ) : null}
        {props.children}
      </div>
    </div>
  );
}

export function Spinner(props: { size?: number; label?: string }): JSX.Element {
  const size = props.size ?? 20;
  return <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} role="status" aria-label={props.label} />;
}
