/**
 * Settings → "Slide size": frame size (auto-scaled into PowerPoint's 56″ limit) or a custom size
 * with presets, cm / in inputs, the resulting slide / frame ratios and a letterbox warning.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { CONFIG } from '../../config';
import type { ExportSettings } from '../../shared/settings';
import { formatNumber, formatPercent, getLang, t, tp } from '../i18n';
import {
  SLIDE_PRESETS,
  clampSlideInches,
  defaultUnit,
  formatLength,
  fromUnit,
  matchPreset,
  ratioText,
  roundToUnit,
  summarizeSlideSize,
  type FrameSize,
  type LengthUnit,
} from '../slide-size';
import { Section, Segmented } from './controls';
import { IconWarning } from './icons';

type SizeSettings = Pick<ExportSettings, 'slideSizeMode' | 'slideWidthIn' | 'slideHeightIn'>;

/** Unit chosen in this session (settings store inches; the unit is a display preference). */
let sessionUnit: LengthUnit | null = null;

function unitLabel(unit: LengthUnit): string {
  return unit === 'cm' ? t('settings.unitCm') : t('settings.unitIn');
}

function LengthField(props: { inches: number; unit: LengthUnit; label: string; onChange: (inches: number) => void }): JSX.Element {
  const { unit } = props;
  return (
    <label class="field length">
      <span class="field-label">{props.label}</span>
      <span class="input-wrap">
        <input
          class="input"
          type="number"
          min={roundToUnit(CONFIG.slide.minInches, unit)}
          max={roundToUnit(CONFIG.slide.maxInches, unit)}
          step={unit === 'cm' ? CONFIG.ui.slideSizeStepCm : CONFIG.ui.slideSizeStepIn}
          value={roundToUnit(props.inches, unit)}
          onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v) && v > 0) props.onChange(clampSlideInches(fromUnit(v, unit)));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          }}
        />
        <span class="input-suffix">{unitLabel(unit)}</span>
      </span>
    </label>
  );
}

function size(wIn: number, hIn: number, unit: LengthUnit): string {
  return `${formatLength(wIn, unit)} × ${formatLength(hIn, unit)} ${unitLabel(unit)}`;
}

export function SlideSizeSettings(props: { settings: SizeSettings; frames: readonly FrameSize[]; onChange: (patch: Partial<ExportSettings>) => void }): JSX.Element {
  const s = props.settings;
  const [unit, setUnitState] = useState<LengthUnit>(() => sessionUnit ?? defaultUnit(getLang()));
  const setUnit = (u: LengthUnit) => {
    sessionUnit = u;
    setUnitState(u);
  };
  const custom = s.slideSizeMode === 'custom';
  const preset = custom ? matchPreset(s.slideWidthIn, s.slideHeightIn) : null;
  const summary = summarizeSlideSize(props.frames, s);
  // Without frames the custom size is still worth showing (and the ratio of what was typed).
  const slideW = summary?.widthIn ?? (custom ? s.slideWidthIn : null);
  const slideH = summary?.heightIn ?? (custom ? s.slideHeightIn : null);

  let warning: string | null = null;
  if (summary && summary.mismatched > 0) {
    if (summary.letterbox) {
      const key = summary.letterbox.axis === 'x' ? 'settings.slideSize.letterboxX' : 'settings.slideSize.letterboxY';
      warning = t(key, {
        frame: ratioText(summary.first.width / summary.first.height),
        slide: ratioText(summary.ratio),
        bar: formatLength(summary.letterbox.barIn, unit),
        unit: unitLabel(unit),
      });
    } else {
      warning = tp('settings.slideSize.mixed', summary.mismatched, { total: formatNumber(summary.frames) });
    }
  }

  return (
    <Section
      title={t('settings.section.slide')}
      aside={
        <Segmented
          value={unit}
          ariaLabel={t('settings.unit')}
          options={[
            { value: 'cm', label: t('settings.unitCm') },
            { value: 'in', label: t('settings.unitIn') },
          ]}
          onChange={setUnit}
        />
      }
    >
      <div class="stack">
        <Segmented
          wide
          value={s.slideSizeMode}
          ariaLabel={t('settings.section.slide')}
          options={[
            { value: 'frame', label: t('settings.slideSize.frame') },
            { value: 'custom', label: t('settings.slideSize.custom') },
          ]}
          onChange={(slideSizeMode) => props.onChange({ slideSizeMode })}
        />
        <div class="row-hint">
          {custom ? t('settings.slideSize.customHint') : t('settings.slideSize.frameHint')} {t('settings.slideSize.pdfNote')}
        </div>
      </div>

      {custom ? (
        <>
          <div class="preset-grid" role="group" aria-label={t('settings.slideSize.presets')}>
            {SLIDE_PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                class={preset?.id === p.id ? 'preset active' : 'preset'}
                aria-pressed={preset?.id === p.id}
                onClick={() => props.onChange({ slideWidthIn: p.widthIn, slideHeightIn: p.heightIn })}
              >
                <span class="preset-label">{t(p.label)}</span>
                <span class="preset-dims">{size(p.widthIn, p.heightIn, unit)}</span>
              </button>
            ))}
          </div>
          <div class="field-pair">
            <LengthField inches={s.slideWidthIn} unit={unit} label={t('settings.width')} onChange={(slideWidthIn) => props.onChange({ slideWidthIn })} />
            <span class="field-times">×</span>
            <LengthField inches={s.slideHeightIn} unit={unit} label={t('settings.height')} onChange={(slideHeightIn) => props.onChange({ slideHeightIn })} />
          </div>
        </>
      ) : null}

      {slideW !== null && slideH !== null ? (
        <dl class="size-summary">
          <dt>{t('settings.slideSize.slide')}</dt>
          <dd>
            {size(slideW, slideH, unit)} <span class="muted">· {ratioText(slideW / slideH)}</span>
          </dd>
          {summary ? (
            <>
              <dt>{t('settings.slideSize.frames')}</dt>
              <dd>
                {Math.round(summary.first.width)} × {Math.round(summary.first.height)} px{' '}
                <span class="muted">· {ratioText(summary.first.width / summary.first.height)}</span>
                {summary.otherSizes > 0 ? <span class="muted"> · {tp('settings.slideSize.otherSizes', summary.otherSizes)}</span> : null}
              </dd>
              <dt>{t('settings.slideSize.scale')}</dt>
              <dd>
                {t('settings.slideSize.scaleValue', { p: formatPercent(summary.scale), pt: formatNumber(summary.scale, undefined, 3) })}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {warning ? (
        <div class="callout warn slim">
          <IconWarning size={14} />
          <span>{warning}</span>
        </div>
      ) : null}
    </Section>
  );
}
