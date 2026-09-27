/**
 * Media parts: SVG sources for `asvg:svgBlip`, and deduplication of byte-identical media
 * (pptxgenjs writes one media part per picture, even for the same bytes).
 */
import type JSZip from 'jszip';

/** Media part name for the k-th SVG asset (0-based). */
export function svgPartName(index: number): string {
  return `ppt/media/fd-svg-${index + 1}.svg`;
}

/** FNV-1a (32 bit) of the bytes — a cheap bucket key; equality is always confirmed byte by byte. */
export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function extOf(path: string): string {
  return /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
}

/**
 * Keep one copy of byte-identical media files (same extension) and point every relationship that
 * targeted a duplicate at the kept copy. Returns the number of removed parts.
 */
export async function dedupeMedia(zip: JSZip): Promise<number> {
  const media = Object.keys(zip.files)
    .filter((p) => p.startsWith('ppt/media/') && !zip.files[p].dir)
    .sort();
  const buckets = new Map<string, Array<{ path: string; bytes: Uint8Array }>>();
  const replace = new Map<string, string>(); // duplicate file name → kept file name (both in ppt/media/)
  for (const path of media) {
    const bytes = await zip.files[path].async('uint8array');
    const key = `${extOf(path)}:${bytes.length}:${fnv1a(bytes)}`;
    const bucket = buckets.get(key) ?? [];
    const keep = bucket.find((b) => sameBytes(b.bytes, bytes));
    if (keep) {
      replace.set(path.slice('ppt/media/'.length), keep.path.slice('ppt/media/'.length));
    } else {
      bucket.push({ path, bytes });
      buckets.set(key, bucket);
    }
  }
  if (replace.size === 0) return 0;

  const relsParts = Object.keys(zip.files).filter((p) => p.endsWith('.rels') && !zip.files[p].dir);
  for (const part of relsParts) {
    const xml = await zip.files[part].async('string');
    const next = xml.replace(/(\bTarget="(?:\.\.\/media\/|\/ppt\/media\/))([^"]+)(")/g, (all, pre: string, file: string, post: string) => {
      const kept = replace.get(file);
      return kept ? pre + kept + post : all;
    });
    if (next !== xml) zip.file(part, next);
  }
  for (const dup of replace.keys()) zip.remove(`ppt/media/${dup}`);
  return replace.size;
}
