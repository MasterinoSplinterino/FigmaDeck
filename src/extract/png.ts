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

/** Size (px) of an SVG document's root element from `width`/`height`, falling back to `viewBox`. */
export function readSvgSize(bytes: Uint8Array): { width: number; height: number } | null {
  const head = asciiPrefix(bytes, 4096);
  const tag = /<svg\b[^>]*>/i.exec(head);
  if (!tag) return null;
  const attr = (name: string): string | undefined => {
    const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag[0]);
    return m ? (m[2] ?? m[3]) : undefined;
  };
  const width = parseLength(attr('width'));
  const height = parseLength(attr('height'));
  if (width !== null && height !== null) return { width, height };
  const vb = attr('viewBox');
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((p) => isFinite(p))) return { width: parts[2], height: parts[3] };
  }
  return null;
}
