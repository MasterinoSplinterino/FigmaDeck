/**
 * Error texts for the UI (pure): whatever was thrown becomes one short readable line — never a stack
 * trace, a multi-line dump or "[object Object]".
 */
import { CONFIG } from '../config';

/** Message of an error value, or '' when there is nothing readable in it. */
function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message || '';
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return '';
}

/**
 * One-line, length-limited message: first non-empty line, a leading "Error:" / "TypeError:"… prefix
 * and stack frames ("    at foo (…)") dropped, cut to CONFIG.ui.errorMessageMaxChars with "…".
 * Returns '' when nothing readable is left (the caller then shows a generic text).
 */
export function cleanErrorMessage(e: unknown, maxChars: number = CONFIG.ui.errorMessageMaxChars): string {
  const lines = rawMessage(e)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l));
  let text = (lines[0] ?? '').replace(/^(?:[A-Z][A-Za-z]*)?Error:\s*/, '').trim();
  if (text === '[object Object]') text = '';
  if (text.length > maxChars) text = `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  return text;
}
