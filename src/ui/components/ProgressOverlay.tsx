/**
 * Modal export progress: phase label, detail line, overall progress bar, Cancel.
 */
import type { JSX } from 'preact';
import { t } from '../i18n';
import { overallFraction, phaseLabel, progressDetail, progressTitle, type ProgressState } from '../progress';
import { Modal } from './controls';

export function ProgressOverlay(props: { progress: ProgressState; onCancel: () => void }): JSX.Element {
  const p = props.progress;
  const fraction = overallFraction(p);
  const pct = Math.round(fraction * 100);
  const indeterminate = p.phase === 'starting' || p.phase === 'package' || p.phase === 'serialize';
  const detail = progressDetail(p);
  return (
    <Modal class="progress-dialog" dismissible={false}>
      <div class="progress-body">
        <div class="progress-title">{progressTitle(p.format)}</div>
        <div class="progress-phase" aria-live="polite">
          {p.cancelling ? t('progress.cancelling') : phaseLabel(p)}
        </div>
        <div class="progress-detail" title={detail}>
          {detail ?? ' '}
        </div>
        <div
          class={indeterminate && pct === 0 ? 'bar indeterminate' : 'bar'}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div class="bar-fill" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
        <div class="progress-foot">
          <span class="progress-pct">{pct}%</span>
          <button type="button" class="btn" onClick={props.onCancel} disabled={!!p.cancelling}>
            {p.cancelling ? t('progress.cancelling') : t('progress.cancel')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
