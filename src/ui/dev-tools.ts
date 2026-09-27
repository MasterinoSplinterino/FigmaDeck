/**
 * Settings → General → "Developer tools": shows the IR JSON (debug) export in the Export menu.
 * A UI-only preference in `localStorage` (not part of the persisted export settings). The Figma plugin
 * iframe may refuse storage (opaque origin): every access is guarded, and the choice then lasts for
 * the session only. Default: off.
 */
const KEY = 'figmadeck.devTools';

/** The page's localStorage, or null when it is missing or access throws (sandboxed iframe, Node). */
function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadDevTools(store: Pick<Storage, 'getItem' | 'setItem'> | null = storage()): boolean {
  try {
    return store?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function saveDevTools(on: boolean, store: Pick<Storage, 'getItem' | 'setItem'> | null = storage()): void {
  try {
    store?.setItem(KEY, on ? '1' : '0');
  } catch {
    // Storage refused: the choice lasts for this session.
  }
}
