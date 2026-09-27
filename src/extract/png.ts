/**
 * Minimal binary sniffing without decoding (the Figma sandbox has no TextDecoder / zlib):
 * PNG header (size, alpha), image MIME by magic number, SVG root size.
 */
import type { AssetMime } from '../ir/types';

export interface PngInfo {
  /** px */
  width: number;
  height: number;
  bitDepth: number;
  /** PNG color type: 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
  colorType: number;
  /** The image MAY contain transparency (alpha channel or a tRNS chunk). */
  hasAlpha: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/**
 * Reads IHDR (must be the first chunk) and scans the chunks before the first IDAT for tRNS.
 * Returns `null` for anything that is not a well-formed PNG header.
 */
export function readPngInfo(bytes: Uint8Array): PngInfo | null {
  if (!isPng(bytes) || bytes.length < 33) return null;
  if (u32(bytes, 8) !== 13 || chunkType(bytes, 12) !== 'IHDR') return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  // Chunks: length (4) + type (4) + data (length) + CRC (4). tRNS must precede IDAT.
  let offset = 8 + 12 + 13;
  while (!hasAlpha && offset + 8 <= bytes.length) {
    const length = u32(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'tRNS') hasAlpha = true;
    offset += 12 + length;
  }
  return { width, height, bitDepth, colorType, hasAlpha };
}

/** Raster formats PowerPoint embeds directly, by magic number. `null` = something else (WebP, HEIC, TIFF…). */
export function sniffImageMime(bytes: Uint8Array): Exclude<AssetMime, 'image/svg+xml'> | null {
  if (isPng(bytes)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // "GIF87a" / "GIF89a"
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  return null;
}

/** Latin-1 view of the first bytes (attribute values of the SVG root are ASCII). */
function asciiPrefix(bytes: Uint8Array, max: number): string {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function parseLength(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?)\s*(px)?\s*$/i.exec(value);
  return m ? parseFloat(m[1]) : null;
}

const SVG_ROOT = /<svg\b[^>]*>/i;

function attrOf(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

function viewBoxOf(tag: string): [number, number, number, number] | null {
  const vb = attrOf(tag, 'viewBox');
  if (!vb) return null;
  const parts = vb.trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts.every((p) => isFinite(p)) ? (parts as [number, number, number, number]) : null;
}

/** Size (px) of an SVG document's root element from `width`/`height`, falling back to `viewBox`. */
export function readSvgSize(bytes: Uint8Array): { width: number; height: number } | null {
  const head = asciiPrefix(bytes, 4096);
  const tag = SVG_ROOT.exec(head);
  if (!tag) return null;
  const width = parseLength(attrOf(tag[0], 'width'));
  const height = parseLength(attrOf(tag[0], 'height'));
  if (width !== null && height !== null) return { width, height };
  const vb = viewBoxOf(tag[0]);
  return vb ? { width: vb[2], height: vb[3] } : null;
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`, 'i');
  if (re.test(tag)) return tag.replace(re, (_m, prefix: string) => `${prefix}"${value}"`);
  return tag.replace(/^<svg\b/i, (open) => `${open} ${name}="${value}"`);
}

const svgNumber = (v: number): string => String(Math.round(v * 1e4) / 1e4);

/**
 * Rewrites the root element's `width` / `height` / `viewBox` size to `width × height` (px, the
 * picture box), keeping the viewBox origin: content drawn at 1 unit = 1 px from the origin keeps its
 * scale, the viewport just matches the PNG next to it. Returns `null` when there is no `<svg>` root.
 * Byte-level (Latin-1 in, Latin-1 out): everything outside the root tag is copied unchanged.
 */
export function setSvgViewport(bytes: Uint8Array, width: number, height: number): Uint8Array | null {
  const head = asciiPrefix(bytes, 4096);
  const m = SVG_ROOT.exec(head);
  if (!m) return null;
  const [ox, oy] = viewBoxOf(m[0]) ?? [0, 0];
  let tag = m[0];
  tag = setAttr(tag, 'width', svgNumber(width));
  tag = setAttr(tag, 'height', svgNumber(height));
  tag = setAttr(tag, 'viewBox', `${svgNumber(ox)} ${svgNumber(oy)} ${svgNumber(width)} ${svgNumber(height)}`);
  const start = m.index;
  const end = start + m[0].length;
  const out = new Uint8Array(bytes.length - m[0].length + tag.length);
  out.set(bytes.subarray(0, start), 0);
  for (let i = 0; i < tag.length; i++) out[start + i] = tag.charCodeAt(i) & 0xff;
  out.set(bytes.subarray(end), start + tag.length);
  return out;
}
