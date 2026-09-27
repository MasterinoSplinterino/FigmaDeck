/**
 * Settings drawer: mode of the editable PowerPoint target, images, text, shapes & layers, slide size,
 * metadata, fonts (naming rule + mapping). Every change is applied immediately (App persists it with a
 * debounced `save-settings`).
 */
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { CONFIG } from '../../config';
import type { FontInfo } from '../../shared/messages';
import type { ExportSettings } from '../../shared/settings';
import { formatNumber, t, tp, type MessageKey } from '../i18n';
import { editableMode } from '../options';
import type { FrameSize } from '../slide-size';
import { Row, Section, Segmented, Slider, Switch } from './controls';
import { FontMapping } from './FontMapping';
import { IconClose, IconReset } from './icons';
import { SlideSizeSettings } from './SlideSizeSettings';

type EditableMode = 'editable' | 'exact';

/** Modes of the "PowerPoint — editable" target (the image targets always bake whole slides). */
const MODES: ReadonlyArray<{ value: EditableMode; label: MessageKey; hint: MessageKey }> = [
  { value: 'editable', label: 'settings.mode.editable', hint: 'settings.mode.editableHint' },
  { value: 'exact', label: 'settings.mode.exact', hint: 'settings.mode.exactHint' },
];

function ModePicker(props: { value: EditableMode; onChange: (mode: EditableMode) => void }): JSX.Element {
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

export interface SettingsPanelProps {
  settings: ExportSettings;
  fonts: FontInfo[] | null;
  /** Frames that will be exported, in order (slide size summary). */
  frames: readonly FrameSize[];
  onChange: (patch: Partial<ExportSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const s = props.settings;
  const set = props.onChange;
  const ref = useRef<HTMLDivElement>(null);
  // Settings that only matter in some modes stay visible but dimmed (no layout jumps when switching).
  const mode = editableMode(s.mode);
  const notEditable = mode !== 'editable';

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
            <ModePicker value={mode} onChange={(next) => set({ mode: next })} />
            <div class="row-hint">{t('settings.modeNote')}</div>
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
            <Row label={t('settings.jpegQuality')} hint={t('settings.jpegQualityHint')}>
              <Slider
                value={s.jpegQuality}
                min={CONFIG.ui.jpegQualityMin}
                max={CONFIG.ui.jpegQualityMax}
                step={CONFIG.ui.jpegQualityStep}
                label={t('settings.jpegQuality')}
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
            <Row label={t('settings.textCase')} hint={t('settings.textCaseHint')} stacked>
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
            <Row label={t('settings.widthSlack')} hint={t('settings.widthSlackHint')}>
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
            <Row label={t('settings.clippedText')} stacked>
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

          <SlideSizeSettings settings={s} frames={props.frames} onChange={set} />

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
