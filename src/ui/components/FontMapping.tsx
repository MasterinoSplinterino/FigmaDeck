/**
 * Font mapping table: Figma "family · style" → PowerPoint face (+ Bold / Italic attributes).
 * Inputs are prefilled with the automatic mapping (`resolveFont`); editing creates an override,
 * the row's reset button (or matching the automatic value) removes it.
 */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { FontInfo } from '../../shared/messages';
import type { ExportSettings, FontOverride } from '../../shared/settings';
import { fontKey } from '../../shared/settings';
import { t, tp } from '../i18n';
import { applyFontOverride, autoFont, effectiveFont } from '../options';
import { Segmented, Spinner } from './controls';
import { IconChevronRight, IconReset } from './icons';

type FontSettings = Pick<ExportSettings, 'fontOverrides' | 'fontNaming'>;

/** Text input that keeps a local draft while focused, so clearing it does not snap back to the default. */
function FaceInput(props: { value: string; placeholder: string; onCommit: (face: string) => void; label: string }): JSX.Element {
  const [draft, setDraft] = useState(props.value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(props.value);
  }, [props.value, focused]);
  return (
    <input
      class="input face-input"
      value={draft}
      placeholder={props.placeholder}
      aria-label={props.label}
      spellcheck={false}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (!draft.trim()) setDraft(props.value);
      }}
      onInput={(e) => {
        const v = (e.currentTarget as HTMLInputElement).value;
        setDraft(v);
        if (v.trim()) props.onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}

function FontRow(props: { font: FontInfo; settings: FontSettings; onOverrides: (next: Record<string, FontOverride>) => void }): JSX.Element {
  const { family, style } = props.font;
  const auto = autoFont(family, style, props.settings.fontNaming);
  const current = effectiveFont(family, style, props.settings);
  const set = (next: FontOverride | null) => props.onOverrides(applyFontOverride(props.settings.fontOverrides, family, style, next, auto));
  const name = `${family} · ${style}`;
  return (
    <div class={current.overridden ? 'font-row overridden' : 'font-row'} key={fontKey(family, style)}>
      <div class="font-figma" title={name}>
        <div class="font-name">
          <span class="font-family">{family}</span>
          <span class="font-dot">·</span>
          <span class="font-style">{style}</span>
        </div>
        <div class="font-meta">
          <span>{tp('settings.fonts.uses', props.font.count)}</span>
          {props.font.missing ? <span class="tag warn">{t('settings.fonts.missing')}</span> : null}
          {current.overridden ? <span class="tag accent">{t('settings.fonts.overridden')}</span> : null}
        </div>
      </div>
      <span class="font-arrow" aria-hidden="true">
        <IconChevronRight size={14} />
      </span>
      <FaceInput
        value={current.face}
        placeholder={auto.face}
        label={`${t('settings.fonts.face')}: ${name}`}
        onCommit={(face) => set({ face, bold: current.bold, italic: current.italic })}
      />
      <button
        type="button"
        class={current.bold ? 'toggle-btn on' : 'toggle-btn'}
        aria-pressed={current.bold}
        title={t('settings.fonts.bold')}
        aria-label={t('settings.fonts.bold')}
        onClick={() => set({ face: current.face, bold: !current.bold, italic: current.italic })}
      >
        <b>B</b>
      </button>
      <button
        type="button"
        class={current.italic ? 'toggle-btn on' : 'toggle-btn'}
        aria-pressed={current.italic}
        title={t('settings.fonts.italic')}
        aria-label={t('settings.fonts.italic')}
        onClick={() => set({ face: current.face, bold: current.bold, italic: !current.italic })}
      >
        <i>I</i>
      </button>
      <button
        type="button"
        class="icon-btn small"
        title={t('settings.fonts.resetRow')}
        aria-label={t('settings.fonts.resetRow')}
        disabled={!current.overridden}
        onClick={() => set(null)}
      >
        <IconReset size={14} />
      </button>
    </div>
  );
}

export function FontMapping(props: {
  fonts: FontInfo[] | null;
  settings: FontSettings;
  onChange: (patch: Partial<ExportSettings>) => void;
}): JSX.Element {
  const fonts = props.fonts ? [...props.fonts].sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style)) : null;
  return (
    <div class="font-mapping">
      <div class="row">
        <div class="row-text">
          <div class="row-label">{t('settings.fonts.naming')}</div>
        </div>
        <div class="row-control">
          <Segmented
            value={props.settings.fontNaming}
            ariaLabel={t('settings.fonts.naming')}
            options={[
              { value: 'ribbi', label: t('settings.fonts.naming.ribbi') },
              { value: 'full', label: t('settings.fonts.naming.full') },
            ]}
            onChange={(fontNaming) => props.onChange({ fontNaming })}
          />
        </div>
      </div>

      {fonts === null ? (
        <div class="font-loading">
          <Spinner size={16} />
          <span>{t('common.loading')}</span>
        </div>
      ) : fonts.length === 0 ? (
        <div class="font-empty">{t('settings.fonts.empty')}</div>
      ) : (
        <div class="font-table" role="table">
          <div class="font-head" role="row">
            <span>{t('settings.fonts.figma')}</span>
            <span />
            <span>{t('settings.fonts.face')}</span>
          </div>
          {fonts.map((f) => (
            <FontRow key={fontKey(f.family, f.style)} font={f} settings={props.settings} onOverrides={(fontOverrides) => props.onChange({ fontOverrides })} />
          ))}
        </div>
      )}

      <details class="ribbi">
        <summary>{t('settings.fonts.ribbiTitle')}</summary>
        <p>{t('settings.fonts.ribbiText')}</p>
      </details>
    </div>
  );
}
