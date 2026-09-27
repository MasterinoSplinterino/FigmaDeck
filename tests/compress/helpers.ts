/** Shared helpers for the src/compress tests: decoders, a chunk reader and synthetic images. */
import * as UPNGModule from '@pdf-lib/upng';
import { PNG } from 'pngjs';

/** The CommonJS build nests the API under `default` (once or twice depending on the loader). */
type Upng = typeof UPNGModule;
function resolveUpng(m: unknown): Upng {
  let x = m as { decode?: unknown; default?: unknown };
  while (x && typeof x.decode !== 'function' && x.default) x = x.default as typeof x;
  return x as unknown as Upng;
}
export const UPNG = resolveUpng(UPNGModule);

/** Decodes with pngjs (which verifies every chunk CRC). */
export function decodePngjs(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

/** Decodes with UPNG to RGBA (second, independent decoder). */
export function decodeUpng(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
  const img = UPNG.decode(buf);
  return { width: img.width, height: img.height, data: new Uint8Array(UPNG.toRGBA8(img)[0]) };
}

export interface Chunk {
  type: string;
  data: Uint8Array;
  crc: number;
  /** Offset of the chunk type (CRC covers type + data). */
  offset: number;
}

export function readChunks(bytes: Uint8Array): Chunk[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const chunks: Chunk[] = [];
  let o = 8;
  while (o < bytes.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    chunks.push({ type, data: bytes.subarray(o + 8, o + 8 + len), crc: dv.getUint32(o + 8 + len), offset: o + 4 });
    o += 12 + len;
  }
  return chunks;
}

export function ihdr(bytes: Uint8Array): { width: number; height: number; bitDepth: number; colorType: number } {
  const c = readChunks(bytes)[0];
  const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.length);
  return { width: dv.getUint32(0), height: dv.getUint32(4), bitDepth: c.data[8], colorType: c.data[9] };
}

/** Distinct RGBA colours of a decoded image (alpha-0 pixels count as one). */
export function distinctColors(rgba: Uint8Array): number {
  const s = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) s.add(rgba[i + 3] === 0 ? 0 : (rgba[i] | (rgba[i + 1] << 8) | (rgba[i + 2] << 16) | (rgba[i + 3] << 24)) >>> 0);
  return s.size;
}

/**
 * Smooth "16-bit-like" test image: a diagonal two-colour gradient under a soft radial alpha falloff
 * (like a blurred Figma layer), with fully transparent corners. Many unique colours, no noise.
 */
export function smoothGradient(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.6;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x + y) / (width + height);
      const d = Math.min(1, Math.hypot(x - cx, y - cy) / r);
      const a = Math.round(255 * (1 - d * d) ** 1.5);
      const p = (y * width + x) * 4;
      if (a === 0) continue;
      out[p] = Math.round(40 + 180 * t);
      out[p + 1] = Math.round(60 + 60 * (1 - t));
      out[p + 2] = Math.round(200 - 90 * t);
      out[p + 3] = a;
    }
  }
  return out;
}

/** Flat UI graphic: a few solid colours on a transparent background (≤ 256 distinct colours). */
export function flatIcon(width: number, height: number, colors: ReadonlyArray<readonly [number, number, number, number]>): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colors[(Math.floor(x / 4) + Math.floor(y / 3)) % colors.length];
      out.set(c, (y * width + x) * 4);
    }
  }
  return out;
}
