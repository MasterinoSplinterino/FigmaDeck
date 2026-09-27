/**
 * Big preview of the selected slide: "01. Name" + "1/N" header, the frame fitted into a dark stage
 * (aspect kept), spinner while the full-size render loads, double-click → show on canvas. When main
 * reports `preview-failed`, the spinner stops and a small error state is shown (over the thumbnail
 * when there is one).
 */
import type { JSX } from 'preact';
import type { SlideInfo } from '../../shared/messages';
import { t } from '../i18n';
import { Spinner } from './controls';
import { IconWarning } from './icons';

/** "01", "02" … "10", "100" — two digits at least. */
export function slideNumberLabel(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function Preview(props: {
  slide: SlideInfo | null;
  index: number;
  total: number;
  /** Full-size preview URL, or the thumbnail as a placeholder. */
  url: string | undefined;
  loading: boolean;
  /** Main could not render the preview: the error text (may be empty), or null. */
  failed: string | null;
  onFocus: (id: string) => void;
}): JSX.Element {
  const s = props.slide;
  // A missing frame main knows no name of is shown as "Missing frame".
  const name = s ? s.name || (s.missing ? t('sidebar.missingName') : '') : '';
  return (
    <div class="preview">
      <div class="preview-head">
        <span class="preview-name" title={name}>
          {s ? `${slideNumberLabel(props.index)}. ${name}` : ''}
        </span>
        <span class="preview-count">{s ? t('preview.counter', { i: props.index + 1, n: props.total }) : ''}</span>
      </div>
      <div
        class={s?.missing ? 'stage missing' : 'stage'}
        title={s && !s.missing ? t('preview.focusHint') : undefined}
        onDblClick={() => s && !s.missing && props.onFocus(s.id)}
      >
        {s?.missing ? (
          <div class="stage-missing">
            <IconWarning size={24} />
            <div class="stage-missing-title">{t('preview.missing')}</div>
            <div class="stage-missing-text">{t('preview.missingHint')}</div>
          </div>
        ) : props.url ? (
          <img class="stage-img" src={props.url} alt={name} draggable={false} />
        ) : props.failed !== null && s ? (
          <div class="stage-missing">
            <IconWarning size={22} />
            <div class="stage-missing-title">{t('preview.failed')}</div>
            <div class="stage-missing-text">{t('preview.failedHint')}</div>
          </div>
        ) : null}
        {props.failed !== null && props.url && !s?.missing && !props.loading ? (
          <div class="stage-badge" title={t('preview.failedHint')}>
            <IconWarning size={13} />
            <span>{t('preview.failed')}</span>
          </div>
        ) : null}
        {props.loading && !s?.missing ? (
          <div class={props.url ? 'stage-loading overlay' : 'stage-loading'}>
            <Spinner size={22} label={t('preview.loading')} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
