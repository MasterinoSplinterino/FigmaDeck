/**
 * Settings → Fonts: the global face naming rule (RIBBI vs full style names) and the font mapping table,
 * Figma "family · style" → PowerPoint face (+ Bold / Italic attributes). Inputs are prefilled with the
 * automatic mapping under the current rule (`resolveFont(family, style, undefined, naming)`); editing
 * creates an override, the row's reset button (or matching the automatic value) removes it.
 */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { FontInfo } from '../../shared/messages';
import type { ExportSettings, FontOverride } from '../../shared/settings';
import { fontKey } from '../../shared/settings';
import { t, tp, type MessageKey } from '../i18n';
import { applyFontOverride, autoFont, effectiveFont } from '../options';
import { Spinner } from './controls';
import { IconChevronRight, IconReset } from './icons';

type FontSettings = Pick<ExportSettings, 'fontOverrides' | 'fontNaming'>;
type Naming = ExportSettings['fontNaming'];

const NAMINGS: ReadonlyArray<{ value: Naming; label: MessageKey; hint: MessageKey }> = [
  { value: 'ribbi', label: 'settings.fonts.naming.ribbi', hint: 'settings.fonts.naming.ribbiHint' },
  { value: 'full', label: 'settings.fonts.naming.full', hint: 'settings.fonts.naming.fullHint' },
];

/** "Inter + B" — the face plus the attributes PowerPoint gets. */
function faceWithAttrs(f: { face: string; bold: boolean; italic: boolean }): string {
  return `${f.face}${f.bold ? ' + B' : ''}${f.italic ? ' + I' : ''}`;
}

/**
 * A font of the deck whose face differs between the two rules (a Bold / Italic style), so the example
 * shows what the switch changes; "Inter · Bold" when the deck has none.
 */
function exampleFont(fonts: readonly FontInfo[] | null): { family: string; style: string } {
  const hit = fonts?.find((f) => {
    const a = autoFont(f.family, f.style, 'ribbi');
    const b = autoFont(f.family, f.style, 'full');
    return a.face !== b.face || a.bold !== b.bold || a.italic !== b.italic;
  });
  return hit ?? { family: 'Inter', style: 'Bold' };
}

function NamingPicker(props: { value: Naming; fonts: readonly FontInfo[] | null; onChange: (naming: Naming) => void }): JSX.Element {
  const ex = exampleFont(props.fonts);
  return (
    <div class="naming">
      <div class="row-label">{t('settings.fonts.naming')}</div>
      <div class="mode-list compact" role="radiogroup" aria-label={t('settings.fonts.naming')}>
        {NAMINGS.map((n) => (
          <button
            type="button"
            key={n.value}
            role="radio"
            aria-checked={props.value === n.value}
            class={props.value === n.value ? 'mode-card active' : 'mode-card'}
            onClick={() => props.onChange(n.value)}
          >
            <span class="mode-radio" aria-hidden="true" />
            <span class="mode-text">
              <span class="mode-label">{t(n.label)}</span>
              <span class="mode-hint">{t(n.hint)}</span>
            </span>
          </button>
        ))}
      </div>
      <div class="row-hint naming-example">
        {t('settings.fonts.naming.example', { figma: `${ex.family} · ${ex.style}`, face: faceWithAttrs(autoFont(ex.family, ex.style, props.value)) })}
      </div>
    </div>
  );
}

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
      <NamingPicker value={props.settings.fontNaming} fonts={props.fonts} onChange={(fontNaming) => props.onChange({ fontNaming })} />
      <div class="row-label font-mapping-title">{t('settings.fonts.mapping')}</div>

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
