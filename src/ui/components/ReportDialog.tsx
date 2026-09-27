/**
 * Report after a successful export: summary tiles, fonts (not embedded!), rasterized layers by slide
 * with localized reasons, skipped layers per slide, warnings / notes; Copy report, Download again.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { CONFIG } from '../../config';
import { formatBytes, formatDuration, reasonLabel, t, tp } from '../i18n';
import { buildReportModel, entryText, reasonHistogram, type ExportOutcome, type SlideGroup } from '../report';
import { Modal } from './controls';
import { IconCheckCircle, IconCopy, IconDownload, IconInfo, IconWarning } from './icons';

function Stat(props: { label: string; value: string | number }): JSX.Element {
  return (
    <div class="stat">
      <div class="stat-value">{props.value}</div>
      <div class="stat-label">{props.label}</div>
    </div>
  );
}

function Block(props: { title: string; count?: number; children: ComponentChildren; open?: boolean; tone?: 'warn' }): JSX.Element {
  return (
    <details class={props.tone === 'warn' ? 'report-block warn' : 'report-block'} open={props.open ?? true}>
      <summary>
        <span class="report-block-title">{props.title}</span>
        {props.count !== undefined ? <span class="badge">{props.count}</span> : null}
      </summary>
      <div class="report-block-body">{props.children}</div>
    </details>
  );
}

function slideHeading(g: SlideGroup<unknown>): string {
  return g.slideNumber > 0 ? t('report.slideLabel', { i: g.slideNumber, name: g.slideName }) : g.slideName;
}

export function ReportDialog(props: { outcome: ExportOutcome; onClose: () => void; onDownloadAgain: () => void; onCopy: () => void }): JSX.Element {
  const o = props.outcome;
  const model = useMemo(() => buildReportModel(o.entries, o.fonts, o.slideIds), [o]);
  const histogram = useMemo(() => reasonHistogram(model), [model]);
  const optimized = o.images ? o.images.downscaled + o.images.jpeg : 0;
  const limit = CONFIG.ui.reportMaxItemsPerSlide;

  return (
    <Modal title={t('report.title')} class="report-dialog" onClose={props.onClose}>
      <div class="report-body">
        <div class="report-file">
          <IconCheckCircle size={18} class="ok" />
          <span class="report-file-name" title={o.fileName}>
            {o.fileName}
          </span>
        </div>

        <div class="stats">
          <Stat label={t('report.slides')} value={o.slideCount} />
          <Stat label={t('report.size')} value={formatBytes(o.data.byteLength)} />
          <Stat label={t('report.duration')} value={formatDuration(o.durationMs)} />
          {o.stats ? (
            <>
              <Stat label={t('report.texts')} value={o.stats.texts} />
              <Stat label={t('report.shapes')} value={o.stats.shapes} />
              <Stat label={t('report.images')} value={o.stats.images} />
              <Stat label={t('report.groups')} value={o.stats.groups} />
            </>
          ) : null}
        </div>
        {optimized > 0 && o.images ? (
          <div class="report-note">
            {t('report.imagesOptimized')}: {optimized} · {formatBytes(o.images.bytesBefore)} → {formatBytes(o.images.bytesAfter)}
          </div>
        ) : null}

        {o.format === 'pptx' ? (
          <Block title={t('report.fonts')} count={model.fonts.length}>
            {model.fonts.length > 0 ? (
              <>
                <div class="callout warn">
                  <IconWarning size={16} />
                  <span>{t('report.fontsWarning')}</span>
                </div>
                <table class="font-report">
                  <thead>
                    <tr>
                      <th>{t('report.fontFigma')}</th>
                      <th>{t('report.fontFace')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {model.fonts.map((f) => (
                      <tr key={`${f.family}::${f.style}`}>
                        <td>
                          {f.family} <span class="muted">· {f.style}</span>
                        </td>
                        <td>
                          <span class="face">{f.face}</span>
                          {f.bold ? <span class="attr">B</span> : null}
                          {f.italic ? <span class="attr italic">I</span> : null}
                        </td>
                        <td class="right">{f.overridden ? <span class="tag accent">{t('report.fontOverridden')}</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <div class="muted">{t('report.noFonts')}</div>
            )}
          </Block>
        ) : null}

        {o.format !== 'pdf' ? (
          <Block title={t('report.raster')} count={model.rasterCount} open={model.rasterCount > 0}>
            {model.raster.length === 0 ? (
              <div class="muted">{t('report.rasterNone')}</div>
            ) : (
              <>
                <div class="chips">
                  {histogram.map((h) => (
                    <span class="chip" key={h.reason}>
                      {reasonLabel(h.reason)} <span class="chip-count">{h.count}</span>
                    </span>
                  ))}
                </div>
                {model.raster.map((g) => (
                  <div class="slide-group" key={g.slideId}>
                    <div class="slide-group-title">
                      {slideHeading(g)} <span class="muted">({g.items.length})</span>
                    </div>
                    <ul class="layer-list">
                      {g.items.slice(0, limit).map((item, i) => (
                        <li key={item.nodeId ?? i}>
                          <span class="layer-name" title={item.nodeType}>
                            {item.nodeName}
                          </span>
                          <span class="layer-reasons">
                            {item.reasons.map((r) => (
                              <span class="reason" key={r}>
                                {reasonLabel(r)}
                              </span>
                            ))}
                          </span>
                        </li>
                      ))}
                      {g.items.length > limit ? <li class="muted">{t('report.moreItems', { n: g.items.length - limit })}</li> : null}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </Block>
        ) : null}

        {model.skipped.length > 0 ? (
          <Block title={t('report.skipped')} count={model.skippedCount} open={false}>
            <ul class="plain-list">
              {model.skipped.map((g) => (
                <li key={g.slideId}>
                  <span class="slide-ref">{slideHeading(g)}</span>
                  <span class="muted">{tp('report.skippedCount', g.items.length)}</span>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}

        {model.warnings.length > 0 ? (
          <Block title={t('report.warnings')} count={model.warnings.length} tone="warn">
            <ul class="plain-list">
              {model.warnings.map((e, i) => (
                <li key={i} title={e.message}>
                  <IconWarning size={14} class="warn" />
                  <span>
                    <span class="slide-ref">{e.slideName}</span> {entryText(e)}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}

        {model.infos.length > 0 ? (
          <Block title={t('report.notes')} count={model.infos.length} open={false}>
            <ul class="plain-list">
              {model.infos.map((e, i) => (
                <li key={i} title={e.message}>
                  <IconInfo size={14} />
                  <span>
                    <span class="slide-ref">{e.slideName}</span> {entryText(e)}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
      </div>

      <footer class="dialog-foot">
        <button type="button" class="btn ghost" onClick={props.onCopy}>
          <IconCopy />
          {t('report.copy')}
        </button>
        <span class="spacer" />
        <button type="button" class="btn" onClick={props.onDownloadAgain}>
          <IconDownload />
          {t('report.downloadAgain')}
        </button>
        <button type="button" class="btn primary" onClick={props.onClose}>
          {t('common.done')}
        </button>
      </footer>
    </Modal>
  );
}
