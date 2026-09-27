/**
 * postMessage bridge between the UI iframe and the plugin main thread (protocol: shared/messages.ts),
 * plus an object-URL cache for thumbnails / previews (PNG bytes → Blob URLs).
 *
 *   UI → main:  parent.postMessage({ pluginMessage: msg }, '*')
 *   main → UI:  window 'message' event, `event.data.pluginMessage`
 */
import type { MainToUi, UiToMain } from '../shared/messages';

const MAIN_TO_UI_TYPES: ReadonlySet<string> = new Set<MainToUi['type']>([
  'init',
  'slides',
  'selection',
  'thumbnail',
  'preview',
  'fonts',
  'export-started',
  'export-progress',
  'export-slide',
  'export-extracted',
  'export-pdf-page',
  'export-pdf-done',
  'export-cancelled',
  'export-error',
  'toast',
]);

/** Structural guard: a plugin message of a known main → UI type. */
export function isMainToUi(value: unknown): value is MainToUi {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && MAIN_TO_UI_TYPES.has(type);
}

/** `event.data.pluginMessage` when it is a main → UI message, else null. */
export function unwrapPluginMessage(data: unknown): MainToUi | null {
  if (!data || typeof data !== 'object') return null;
  const msg = (data as { pluginMessage?: unknown }).pluginMessage;
  return isMainToUi(msg) ? msg : null;
}

export function send(msg: UiToMain): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

/** Subscribe to main → UI messages. Returns the unsubscribe function. */
export function listen(handler: (msg: MainToUi) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    const msg = unwrapPluginMessage(event.data);
    if (msg) handler(msg);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/**
 * id → object URL of an image. Replacing or dropping an entry revokes its previous URL, so a long
 * session does not leak Blob memory.
 */
export class ObjectUrlCache {
  private readonly urls = new Map<string, string>();

  constructor(
    private readonly create: (blob: Blob) => string = (b) => URL.createObjectURL(b),
    private readonly revoke: (url: string) => void = (u) => URL.revokeObjectURL(u),
  ) {}

  get(id: string): string | undefined {
    return this.urls.get(id);
  }

  /** Store `bytes` for `id`; returns the new URL. */
  set(id: string, bytes: Uint8Array, mime = 'image/png'): string {
    // Copy into a fresh ArrayBuffer-backed view: the message buffer may be shared / transferred.
    const blob = new Blob([bytes.slice()], { type: mime });
    const url = this.create(blob);
    const old = this.urls.get(id);
    this.urls.set(id, url);
    if (old) this.revoke(old);
    return url;
  }

  delete(id: string): void {
    const old = this.urls.get(id);
    if (old) this.revoke(old);
    this.urls.delete(id);
  }

  /** Drop every entry whose id is not in `ids`. Returns true when something was removed. */
  retain(ids: Iterable<string>): boolean {
    const keep = new Set(ids);
    let changed = false;
    for (const id of [...this.urls.keys()]) {
      if (!keep.has(id)) {
        this.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Plain snapshot for rendering. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.urls);
  }

  clear(): void {
    for (const url of this.urls.values()) this.revoke(url);
    this.urls.clear();
  }
}
