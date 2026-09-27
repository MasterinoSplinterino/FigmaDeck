/**
 * Asset store for one extraction: dedupes binaries, hands out ids, and tracks which assets are new
 * since the last streamed slide (`takeNew`).
 *
 * Dedupe keys: image fills by Figma image hash (`imageKey(hash)`), exports by a 64-bit content hash
 * (two independent 32-bit lanes) + byte length + mime + role. Only the hash is kept for the dedupe, never
 * the bytes, so a streaming consumer can let the store drop them (`releaseSent`): after a slide's assets
 * were handed over, only their metadata stays here (the consumer keeps the bytes).
 *
 * When an asset that was already streamed is reused at a LARGER display size, it is queued again with
 * the updated `displayWidth/Height` (the UI must replace assets by id) so the UI never downscales it
 * below what a later slide needs. That matters for image fills only (the UI downscales nothing else by
 * display size; a raster's own pixels = display × its export scale ≤ display × rasterScale), so a
 * released asset is re-queued only when its bytes can be read again (`reloadPending`: image fills by
 * their Figma image hash).
 */
import type { Asset, AssetMime, AssetRole } from '../ir/types';

export interface AssetInput {
  mime: AssetMime;
  role: AssetRole;
  data: Uint8Array;
  width: number;
  height: number;
  hasAlpha?: boolean;
  displayWidth?: number;
  displayHeight?: number;
}

const ID_PREFIX: Record<AssetRole, string> = {
  'image-fill': 'img',
  background: 'bg',
  raster: 'ras',
  'vector-fallback': 'vec',
  svg: 'svg',
};

const IMAGE_KEY_PREFIX = 'hash:';

/** Dedupe key of a Figma image (image fills). */
export function imageKey(imageHash: string): string {
  return `${IMAGE_KEY_PREFIX}${imageHash}`;
}

/** The Figma image hash of an `imageKey`, or null for other keys. */
export function imageHashOfKey(key: string): string | null {
  return key.startsWith(IMAGE_KEY_PREFIX) ? key.slice(IMAGE_KEY_PREFIX.length) : null;
}

/** FNV-1a 32-bit over the bytes. */
export function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Content hash for dedupe: byte length + FNV-1a 32 + a second, independently mixed 32-bit lane
 * (multiply-xorshift) — ~64 bits, so identical keys mean identical bytes without keeping them.
 */
export function contentHash(data: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return `${data.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

/** Reads the bytes of a released asset again by its dedupe key (null = not possible). */
export type AssetReloader = (key: string) => Promise<Uint8Array | null>;

interface Entry {
  asset: Asset;
  /** Dedupe key given to `add` (image fills: `imageKey`), used to read released bytes again. */
  key?: string;
  /** The bytes were dropped (`releaseSent`); `asset.data` is empty. */
  released: boolean;
}

const NO_BYTES = new Uint8Array(0);

export class AssetStore {
  private readonly entries = new Map<string, Entry>();
  private readonly byKey = new Map<string, string>();
  private readonly byContent = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly sent = new Set<string>();
  private pending: string[] = [];

  /** Id of an asset previously stored under `key` (e.g. an image hash). */
  lookup(key: string): string | undefined {
    return this.byKey.get(key);
  }

  /** The asset (after `releaseSent` its `data` may be empty). */
  get(id: string): Asset | undefined {
    return this.entries.get(id)?.asset;
  }

  /** Stores (or reuses) an asset. `key` = explicit dedupe key; otherwise the content is hashed. */
  add(input: AssetInput, key?: string): string {
    if (key) {
      const existing = this.byKey.get(key);
      if (existing) {
        this.noteDisplaySize(existing, input.displayWidth, input.displayHeight);
        return existing;
      }
    }
    const contentKey = `${input.mime}|${input.role}|${contentHash(input.data)}`;
    const same = this.byContent.get(contentKey);
    if (same) {
      if (key) this.byKey.set(key, same);
      this.noteDisplaySize(same, input.displayWidth, input.displayHeight);
      return same;
    }
    const prefix = ID_PREFIX[input.role];
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const id = `${prefix}${n}`;
    const asset: Asset = {
      id,
      mime: input.mime,
      role: input.role,
      data: input.data,
      width: input.width,
      height: input.height,
    };
    if (input.hasAlpha !== undefined) asset.hasAlpha = input.hasAlpha;
    if (input.displayWidth !== undefined) asset.displayWidth = input.displayWidth;
    if (input.displayHeight !== undefined) asset.displayHeight = input.displayHeight;
    this.entries.set(id, { asset, key, released: false });
    if (key) this.byKey.set(key, id);
    this.byContent.set(contentKey, id);
    this.pending.push(id);
    return id;
  }

  /**
   * Grow the recorded display size (px); re-queues an already streamed asset when it grew and it can
   * be sent again with its bytes (still held, or an image fill that `reloadPending` can re-read).
   */
  noteDisplaySize(id: string, width?: number, height?: number): void {
    const entry = this.entries.get(id);
    if (!entry || width === undefined || height === undefined) return;
    const a = entry.asset;
    const grew = width > (a.displayWidth ?? 0) + 1e-6 || height > (a.displayHeight ?? 0) + 1e-6;
    if (!grew) return;
    a.displayWidth = Math.max(a.displayWidth ?? 0, width);
    a.displayHeight = Math.max(a.displayHeight ?? 0, height);
    const resendable = !entry.released || (a.role === 'image-fill' && entry.key !== undefined && imageHashOfKey(entry.key) !== null);
    if (this.sent.has(id) && resendable && !this.pending.includes(id)) this.pending.push(id);
  }

  /**
   * Read the bytes of queued re-sends whose bytes were released. An asset whose bytes cannot be read
   * is not re-sent (the consumer keeps the copy it has).
   */
  async reloadPending(reload: AssetReloader): Promise<void> {
    const keep: string[] = [];
    for (const id of this.pending) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (entry.released) {
        let bytes: Uint8Array | null = null;
        try {
          bytes = entry.key !== undefined ? await reload(entry.key) : null;
        } catch {
          bytes = null;
        }
        if (!bytes || bytes.length === 0) continue;
        entry.asset = { ...entry.asset, data: bytes };
        entry.released = false;
      }
      keep.push(id);
    }
    this.pending = keep;
  }

  /** Assets added (or grown) since the previous call, in insertion order — always with their bytes. */
  takeNew(): Asset[] {
    const out: Asset[] = [];
    for (const id of this.pending) {
      const entry = this.entries.get(id);
      if (!entry || entry.released) continue; // never hand out an asset without its bytes
      out.push(entry.asset);
      this.sent.add(id);
    }
    this.pending = [];
    return out;
  }

  /**
   * Drop the bytes of every asset already handed out (the consumer keeps them); ids, dedupe hashes and
   * metadata stay. The handed-out objects are not touched (the store keeps a copy without the bytes).
   */
  releaseSent(): void {
    for (const id of this.sent) {
      const entry = this.entries.get(id);
      if (!entry || entry.released || this.pending.includes(id)) continue;
      entry.asset = { ...entry.asset, data: NO_BYTES };
      entry.released = true;
    }
  }

  /** The assets still held with their bytes, as the IR record (released ones are left out). */
  toRecord(): Record<string, Asset> {
    const out: Record<string, Asset> = {};
    for (const [id, e] of this.entries) if (!e.released) out[id] = e.asset;
    return out;
  }

  /** Number of distinct assets stored so far (released ones included). */
  get size(): number {
    return this.entries.size;
  }
}
