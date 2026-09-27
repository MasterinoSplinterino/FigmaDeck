/**
 * Top bar of the deck view: editable deck title (text that turns into an input on click),
 * Settings, Clear All and the Export split button with its format menu.
 */
import { Fragment, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExportFormat } from '../../shared/settings';
import { t, type MessageKey } from '../i18n';
import { IconChevronDown, IconFileCode, IconFilePdf, IconFileSlides, IconImage, IconSettings } from './icons';

function DeckTitle(props: { value: string; placeholder: string; onCommit: (title: string) => void }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(props.value);
  }, [props.value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== props.value.trim()) props.onCommit(next);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        class="title-input"
        value={draft}
        placeholder={props.placeholder}
        aria-label={t('top.titleEdit')}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft(props.value);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button type="button" class={props.value ? 'title-text' : 'title-text placeholder'} title={t('top.titleEdit')} onClick={() => setEditing(true)}>
      {props.value || props.placeholder}
    </button>
  );
}

interface MenuItem {
  format: ExportFormat;
  label: MessageKey;
  hint: MessageKey;
  icon: (p: { size?: number }) => JSX.Element;
  separatorBefore?: boolean;
}

const MENU: readonly MenuItem[] = [
  { format: 'pptx', label: 'export.pptx', hint: 'export.pptxHint', icon: IconFileSlides },
  { format: 'pptx-image', label: 'export.pptxImage', hint: 'export.pptxImageHint', icon: IconImage },
  { format: 'pdf', label: 'export.pdf', hint: 'export.pdfHint', icon: IconFilePdf, separatorBefore: true },
  { format: 'pdf-image', label: 'export.pdfImage', hint: 'export.pdfImageHint', icon: IconImage },
  { format: 'ir-json', label: 'export.irJson', hint: 'export.irJsonHint', icon: IconFileCode, separatorBefore: true },
];

function ExportButton(props: { disabled: boolean; onExport: (format: ExportFormat) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const choose = (format: ExportFormat) => {
    setOpen(false);
    props.onExport(format);
  };

  return (
    <div class="split" ref={ref}>
      <button type="button" class="btn primary split-main" disabled={props.disabled} onClick={() => choose('pptx')} title={t('export.pptx')}>
        {t('top.export')}
      </button>
      <button
        type="button"
        class="btn primary split-toggle"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('top.exportMenu')}
        title={t('top.exportMenu')}
        onClick={() => setOpen(!open)}
      >
        <IconChevronDown />
      </button>
      {open ? (
        <div class="menu" role="menu">
          {MENU.map((item) => (
            <Fragment key={item.format}>
              {item.separatorBefore ? <div class="menu-sep" role="separator" /> : null}
              <button type="button" role="menuitem" class="menu-item" onClick={() => choose(item.format)}>
                <span class="menu-icon">
                  <item.icon size={16} />
                </span>
                <span class="menu-text">
                  <span class="menu-label">{t(item.label)}</span>
                  <span class="menu-hint">{t(item.hint)}</span>
                </span>
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TopBarProps {
  title: string;
  placeholder: string;
  canExport: boolean;
  onTitle: (title: string) => void;
  onSettings: () => void;
  onClear: () => void;
  onExport: (format: ExportFormat) => void;
}

export function TopBar(props: TopBarProps): JSX.Element {
  return (
    <header class="topbar">
      <DeckTitle value={props.title} placeholder={props.placeholder} onCommit={props.onTitle} />
      <div class="topbar-actions">
        <button type="button" class="btn" onClick={props.onSettings}>
          <IconSettings />
          {t('top.settings')}
        </button>
        <button type="button" class="btn" onClick={props.onClear}>
          {t('top.clearAll')}
        </button>
        <ExportButton disabled={!props.canExport} onExport={props.onExport} />
      </div>
    </header>
  );
}
