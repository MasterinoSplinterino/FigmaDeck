/**
 * File names, Blob downloads and clipboard access for the UI iframe.
 */
import { CONFIG } from '../config';

/** Characters Windows / macOS do not accept in file names, plus ASCII control characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
/** Names Windows reserves regardless of extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Safe base name (no extension) from a deck title: forbidden characters → space, whitespace
 * collapsed, leading/trailing dots and spaces removed, length limited; empty → fallback.
 */
export function safeFileBase(title: string, fallback: string = CONFIG.ui.fallbackFileName): string {
  let s = (title ?? '').normalize('NFC').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > CONFIG.ui.maxFileNameLength) s = s.slice(0, CONFIG.ui.maxFileNameLength).trim();
  if (!s || RESERVED.test(s)) return fallback;
  return s;
}

/** "<safe title><extension>", e.g. "Startup Summit - 2026.pptx". */
export function fileNameFor(title: string, extension: string): string {
  return safeFileBase(title) + extension;
}

/** Save bytes as a file through a temporary `<a download>` link. */
export function downloadBytes(data: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([data.slice()], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; give it time.
  setTimeout(() => URL.revokeObjectURL(url), CONFIG.ui.downloadRevokeMs);
}

/**
 * Copy text to the clipboard. The async Clipboard API is often blocked inside the Figma plugin
 * iframe, so a hidden textarea + `execCommand('copy')` is the fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
