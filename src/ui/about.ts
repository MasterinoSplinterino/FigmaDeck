/**
 * Settings → About (pure): the product version and the text of the bundled open-source licenses.
 */
import { CONFIG } from '../config';

/** package.json "version", replaced by esbuild `define` (scripts/build.mjs); not defined in Node tests. */
declare const __APP_VERSION__: string | undefined;

/** The product version shown in Settings → About; 'dev' when not bundled (tests). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';

export interface Notice {
  name: string;
  version: string;
  license: string;
  url: string;
  text: string;
}

/** A line that starts a list item, a heading or an underline: kept on its own line when reflowing. */
const STRUCTURED_LINE = /^\s*(?:\d+[.)]|[-*•#]|={3,}|-{3,})/;

/**
 * License files are hard-wrapped at ~80 columns; in a narrow viewer that leaves ragged half-lines.
 * Prose paragraphs are joined into one line each (the viewer wraps them); paragraphs with list items,
 * headings or indented lines keep their line breaks.
 */
export function reflowLicense(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/)
    .map((paragraph) => {
      const lines = paragraph.split('\n');
      const structured = lines.some((l, i) => STRUCTURED_LINE.test(l) || (i > 0 && /^\s{2,}\S/.test(l)));
      return structured ? paragraph : lines.map((l) => l.trim()).join(' ');
    })
    .join('\n\n');
}

/** Plain-text license notices for the read-only viewer: one block per package, separated by rules. */
export function noticesText(notices: readonly Notice[]): string {
  return notices
    .map((n) => [`${n.name} ${n.version}`.trim(), [n.license, n.url].filter(Boolean).join(' · '), '', reflowLicense(n.text)].join('\n'))
    .join('\n\n────────────────────────────────────────\n\n');
}

/** Support links of the About section (only the configured ones). */
export function supportLinks(meta: { supportUrl: string; supportEmail: string } = CONFIG.meta): { url: string | null; email: string | null } {
  const url = meta.supportUrl.trim();
  const email = meta.supportEmail.trim();
  return { url: /^https?:\/\//i.test(url) ? url : null, email: email.includes('@') ? email : null };
}
