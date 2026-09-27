/**
 * Settings → About: product name and version, the privacy statement, support links (CONFIG.meta,
 * only the configured ones) and the bundled open-source licenses (read-only, scrollable; the text is
 * generated at build time from node_modules, see scripts/build.mjs → THIRD_PARTY_NOTICES.md).
 * Browser bundle only: `figmadeck:licenses` exists in the esbuild build, not in Node tests.
 */
import notices from 'figmadeck:licenses';
import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { CONFIG } from '../../config';
import { APP_VERSION, noticesText, supportLinks } from '../about';
import { t } from '../i18n';
import { Row, Section } from './controls';
import { IconExternal, IconLock, IconMail } from './icons';

export function AboutSection(): JSX.Element {
  const [licensesOpen, setLicensesOpen] = useState(false);
  const links = supportLinks();
  const text = useMemo(() => (licensesOpen ? noticesText(notices) : ''), [licensesOpen]);
  return (
    <Section title={t('settings.section.about')}>
      <div class="about-product">
        <span class="about-name">{CONFIG.meta.productName}</span>
        <span class="about-version">{t('about.version', { version: APP_VERSION })}</span>
      </div>
      <div class="about-privacy">
        <IconLock size={14} />
        <span>{t('about.privacy')}</span>
      </div>
      {links.url || links.email ? (
        <Row label={t('about.support')}>
          <span class="about-links">
            {links.url ? (
              <a class="link" href={links.url} target="_blank" rel="noopener noreferrer">
                {links.url.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
                <IconExternal size={12} />
              </a>
            ) : null}
            {links.email ? (
              <a class="link" href={`mailto:${links.email}`} target="_blank" rel="noopener noreferrer" title={t('about.emailTitle', { email: links.email })}>
                <IconMail size={12} />
                {links.email}
              </a>
            ) : null}
          </span>
        </Row>
      ) : null}
      <details class="licenses" onToggle={(e) => setLicensesOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span>{t('about.licenses')}</span>
          <span class="badge">{notices.length}</span>
        </summary>
        {licensesOpen ? (
          <>
            <div class="row-hint">{t('about.licensesIntro')}</div>
            <pre class="licenses-text" tabIndex={0} aria-label={t('about.licenses')}>
              {text}
            </pre>
          </>
        ) : null}
      </details>
    </Section>
  );
}
