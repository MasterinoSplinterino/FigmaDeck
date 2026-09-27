/**
 * Asset store for one extraction: dedupes binaries, hands out ids, and tracks which assets are new
 * since the last streamed slide (`takeNew`).
 *
 * Dedupe keys: image fills by Figma image hash (`hash:<imageHash>`), exports by content hash + mime +
 * role. When an asset that was already streamed is reused at a LARGER display size, it is queued again
 * with the updated `displayWidth/Height` (the UI must replace assets by id) so the UI never downscales
 * it below what a later slide needs.
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

/** FNV-1a 32-bit over the bytes (dedupe key; collisions are resolved by a byte compare). */
export function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class AssetStore {
  private readonly assets = new Map<string, Asset>();
  private readonly byKey = new Map<string, string>();
  private readonly byContent = new Map<string, string[]>();
  private readonly counters = new Map<string, number>();
  private readonly sent = new Set<string>();
  private pending: string[] = [];

  /** Id of an asset previously stored under `key` (e.g. an image hash). */
  lookup(key: string): string | undefined {
    return this.byKey.get(key);
  }

  get(id: string): Asset | undefined {
    return this.assets.get(id);
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
    const contentKey = `${input.mime}|${input.role}|${input.data.length}|${fnv1a(input.data)}`;
    for (const id of this.byContent.get(contentKey) ?? []) {
      const a = this.assets.get(id);
      if (a && sameBytes(a.data, input.data)) {
        if (key) this.byKey.set(key, id);
        this.noteDisplaySize(id, input.displayWidth, input.displayHeight);
        return id;
      }
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
    this.assets.set(id, asset);
    if (key) this.byKey.set(key, id);
    const list = this.byContent.get(contentKey);
    if (list) list.push(id);
    else this.byContent.set(contentKey, [id]);
    this.pending.push(id);
    return id;
  }

  /** Grow the recorded display size (px); re-queues an already streamed asset when it grew. */
  noteDisplaySize(id: string, width?: number, height?: number): void {
    const a = this.assets.get(id);
    if (!a || width === undefined || height === undefined) return;
    const grew = width > (a.displayWidth ?? 0) + 1e-6 || height > (a.displayHeight ?? 0) + 1e-6;
    if (!grew) return;
    a.displayWidth = Math.max(a.displayWidth ?? 0, width);
    a.displayHeight = Math.max(a.displayHeight ?? 0, height);
    if (this.sent.has(id) && !this.pending.includes(id)) this.pending.push(id);
  }

  /** Assets added (or grown) since the previous call, in insertion order. */
  takeNew(): Asset[] {
    const out = this.pending.map((id) => this.assets.get(id)!).filter(Boolean);
    for (const id of this.pending) this.sent.add(id);
    this.pending = [];
    return out;
  }

  /** All assets as the IR record. */
  toRecord(): Record<string, Asset> {
    const out: Record<string, Asset> = {};
    for (const [id, a] of this.assets) out[id] = a;
    return out;
  }

  get size(): number {
    return this.assets.size;
  }
}
