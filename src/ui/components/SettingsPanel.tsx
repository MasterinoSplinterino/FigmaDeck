/**
 * Settings drawer: export mode, images, text, shapes & layers, slide size, metadata, font mapping.
 * Every change is applied immediately (App persists it with a debounced `save-settings`).
 */
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { CONFIG } from '../../config';
import type { FontInfo } from '../../shared/messages';
import type { ExportMode, ExportSettings } from '../../shared/settings';
import { formatNumber, t, tp, type MessageKey } from '../i18n';
import { Row, Section, Segmented, Slider, Switch } from './controls';
import { FontMapping } from './FontMapping';
import { IconClose, IconReset } from './icons';

const MODES: ReadonlyArray<{ value: ExportMode; label: MessageKey; hint: MessageKey }> = [
  { value: 'editable', label: 'settings.mode.editable', hint: 'settings.mode.editableHint' },
  { value: 'exact', label: 'settings.mode.exact', hint: 'settings.mode.exactHint' },
  { value: 'image', label: 'settings.mode.image', hint: 'settings.mode.imageHint' },
];

function ModePicker(props: { value: ExportMode; onChange: (mode: ExportMode) => void }): JSX.Element {
  return (
    <div class="mode-list" role="radiogroup" aria-label={t('settings.section.mode')}>
      {MODES.map((m) => (
        <button
          type="button"
          key={m.value}
          role="radio"
          aria-checked={props.value === m.value}
          class={props.value === m.value ? 'mode-card active' : 'mode-card'}
          onClick={() => props.onChange(m.value)}
        >
          <span class="mode-radio" aria-hidden="true" />
          <span class="mode-text">
            <span class="mode-label">{t(m.label)}</span>
            <span class="mode-hint">{t(m.hint)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TextField(props: { value: string; label: string; onChange: (v: string) => void; placeholder?: string }): JSX.Element {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <input class="input" value={props.value} placeholder={props.placeholder} onInput={(e) => props.onChange((e.currentTarget as HTMLInputElement).value)} />
    </label>
  );
}

function InchField(props: { value: number; label: string; onChange: (v: number) => void }): JSX.Element {
  return (
    <label class="field inch">
      <span class="field-label">{props.label}</span>
      <span class="input-wrap">
        <input
          class="input"
          type="number"
          min={CONFIG.slide.minInches}
          max={CONFIG.slide.maxInches}
          step={CONFIG.ui.slideSizeStepIn}
          value={props.value}
          onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) props.onChange(Math.max(CONFIG.slide.minInches, Math.min(CONFIG.slide.maxInches, v)));
          }}
        />
        <span class="input-suffix">{t('settings.unitIn')}</span>
      </span>
    </label>
  );
}

export interface SettingsPanelProps {
  settings: ExportSettings;
  fonts: FontInfo[] | null;
  onChange: (patch: Partial<ExportSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const s = props.settings;
  const set = props.onChange;
  const ref = useRef<HTMLDivElement>(null);
  // Settings that only matter in some modes stay visible but dimmed (no layout jumps when switching).
  const notEditable = s.mode !== 'editable';
  const imageMode = s.mode === 'image';

  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      // Escape inside a field only leaves the field; the next one closes the drawer.
      if (e.target instanceof HTMLInputElement) e.target.blur();
      else onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const fontCount = props.fonts?.length ?? 0;

  return (
    <div
      class="drawer-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="drawer" role="dialog" aria-modal="true" aria-label={t('settings.title')} tabIndex={-1} ref={ref}>
        <header class="drawer-head">
          <h2 class="dialog-title">{t('settings.title')}</h2>
          <button type="button" class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onClick={props.onClose}>
            <IconClose />
          </button>
        </header>

        <div class="drawer-body">
          <Section title={t('settings.section.mode')}>
            <ModePicker value={s.mode} onChange={(mode) => set({ mode })} />
          </Section>

          <Section title={t('settings.section.images')}>
            <Row label={t('settings.scale')} hint={t('settings.scaleHint')}>
              <Segmented
                value={s.rasterScale}
                ariaLabel={t('settings.scale')}
                options={[
                  { value: 1, label: '1x' },
                  { value: 2, label: '2x' },
                  { value: 3, label: '3x' },
                ]}
                onChange={(rasterScale) => set({ rasterScale })}
              />
            </Row>
            <Row label={t('settings.jpeg')} hint={t('settings.jpegHint')}>
              <Switch checked={s.jpeg} label={t('settings.jpeg')} onChange={(jpeg) => set({ jpeg })} />
            </Row>
            <Row label={t('settings.jpegQuality')}>
              <Slider
                value={s.jpegQuality}
                min={CONFIG.ui.jpegQualityMin}
                max={CONFIG.ui.jpegQualityMax}
                step={CONFIG.ui.jpegQualityStep}
                label={t('settings.jpegQuality')}
                disabled={!s.jpeg}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(jpegQuality) => set({ jpegQuality })}
              />
            </Row>
            <Row label={t('settings.imageFills')} hint={t('settings.imageFillsHint')} stacked inactive={notEditable}>
              <Segmented
                wide
                value={s.imageFills}
                ariaLabel={t('settings.imageFills')}
                options={[
                  { value: 'original', label: t('settings.imageFills.original') },
                  { value: 'rasterize', label: t('settings.imageFills.rasterize') },
                ]}
                onChange={(imageFills) => set({ imageFills })}
              />
            </Row>
            <Row label={t('settings.svg')} hint={t('settings.svgHint')} inactive={notEditable}>
              <Switch checked={s.svgVectors} label={t('settings.svg')} onChange={(svgVectors) => set({ svgVectors })} />
            </Row>
          </Section>

          <Section title={t('settings.section.text')}>
            <Row label={t('settings.textCase')} hint={t('settings.textCaseHint')} stacked inactive={imageMode}>
              <Segmented
                wide
                value={s.textCase}
                ariaLabel={t('settings.textCase')}
                options={[
                  { value: 'cap', label: t('settings.textCase.cap') },
                  { value: 'transform', label: t('settings.textCase.transform') },
                ]}
                onChange={(textCase) => set({ textCase })}
              />
            </Row>
            <Row label={t('settings.widthSlack')} hint={t('settings.widthSlackHint')} inactive={imageMode}>
              <Slider
                value={s.widthSlackPercent}
                min={0}
                max={CONFIG.ui.widthSlackMax}
                step={CONFIG.ui.widthSlackStep}
                label={t('settings.widthSlack')}
                format={(v) => `${formatNumber(v, undefined, 1)}%`}
                onChange={(widthSlackPercent) => set({ widthSlackPercent })}
              />
            </Row>
            <Row label={t('settings.clippedText')} stacked inactive={imageMode}>
              <Segmented
                wide
                value={s.clippedText}
                ariaLabel={t('settings.clippedText')}
                options={[
                  { value: 'rasterize', label: t('settings.clippedText.rasterize') },
                  { value: 'keep', label: t('settings.clippedText.keep') },
                ]}
                onChange={(clippedText) => set({ clippedText })}
              />
            </Row>
          </Section>

          <Section title={t('settings.section.layers')}>
            <Row label={t('settings.groups')} hint={t('settings.groupsHint')} inactive={notEditable}>
              <Switch checked={s.preserveGroups} label={t('settings.groups')} onChange={(preserveGroups) => set({ preserveGroups })} />
            </Row>
            <Row label={t('settings.gradients')} hint={t('settings.gradientsHint')} inactive={notEditable}>
              <Switch checked={s.nativeGradients} label={t('settings.gradients')} onChange={(nativeGradients) => set({ nativeGradients })} />
            </Row>
          </Section>

          <Section title={t('settings.section.slide')}>
            <div class="stack">
              <Segmented
                wide
                value={s.slideSizeMode}
                ariaLabel={t('settings.section.slide')}
                options={[
                  { value: 'frame', label: t('settings.slideSize.frame') },
                  { value: 'custom', label: t('settings.slideSize.custom') },
                ]}
                onChange={(slideSizeMode) => set({ slideSizeMode })}
              />
              <div class="row-hint">{s.slideSizeMode === 'custom' ? t('settings.slideSizeCustomHint') : t('settings.slideSizeHint')}</div>
            </div>
            {s.slideSizeMode === 'custom' ? (
              <div class="field-pair">
                <InchField value={s.slideWidthIn} label={t('settings.width')} onChange={(slideWidthIn) => set({ slideWidthIn })} />
                <span class="field-times">×</span>
                <InchField value={s.slideHeightIn} label={t('settings.height')} onChange={(slideHeightIn) => set({ slideHeightIn })} />
              </div>
            ) : null}
          </Section>

          <Section title={t('settings.section.meta')}>
            <div class="field-pair">
              <TextField value={s.author} label={t('settings.author')} onChange={(author) => set({ author })} />
              <TextField value={s.company} label={t('settings.company')} onChange={(company) => set({ company })} />
            </div>
            <div class="row-hint">{t('settings.metaHint')}</div>
          </Section>

          <Section title={t('settings.section.fonts')} aside={props.fonts ? <span class="badge">{tp('settings.fonts.count', fontCount)}</span> : null}>
            <FontMapping fonts={props.fonts} settings={s} onChange={set} />
          </Section>
        </div>

        <footer class="drawer-foot">
          <button type="button" class="btn ghost" onClick={props.onReset}>
            <IconReset />
            {t('settings.reset')}
          </button>
          <span class="spacer" />
          <button type="button" class="btn primary" onClick={props.onClose}>
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  );
}
