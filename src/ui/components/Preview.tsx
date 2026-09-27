/**
 * Big preview of the selected slide: "01. Name" + "1/N" header, the frame fitted into a dark stage
 * (aspect kept), spinner while the full-size render loads, double-click → show on canvas.
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
  onFocus: (id: string) => void;
}): JSX.Element {
  const s = props.slide;
  return (
    <div class="preview">
      <div class="preview-head">
        <span class="preview-name" title={s?.name}>
          {s ? `${slideNumberLabel(props.index)}. ${s.name}` : ''}
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
          <img class="stage-img" src={props.url} alt={s?.name ?? ''} draggable={false} />
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
