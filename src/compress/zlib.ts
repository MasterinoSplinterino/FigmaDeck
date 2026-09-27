/**
 * Typed access to `pako` (zlib in plain JS: same output in the browser and in Node).
 * pako 1.x ships no typings and @types/pako is not a dependency, so the few functions used here are
 * typed locally instead of declaring the module globally (which could clash with a declaration
 * added elsewhere later).
 */
// @ts-ignore -- untyped CommonJS module (see above); the default import is its `module.exports`.
import pakoModule from 'pako';

/** zlib strategies (zlib.h values). */
export const Z_DEFAULT_STRATEGY = 0;
export const Z_FILTERED = 1;
export const Z_RLE = 3;

export interface DeflateOptions {
  /** 0..9 */
  level: number;
  /** 1..9 (9 = most memory, best ratio). */
  memLevel?: number;
  strategy?: number;
}

interface Pako {
  deflate(data: Uint8Array, options?: { level?: number; memLevel?: number; strategy?: number }): Uint8Array;
  inflate(data: Uint8Array): Uint8Array;
}

const pako = pakoModule as Pako;

/** zlib stream (2-byte header + DEFLATE + Adler-32), as PNG's IDAT expects. */
export function zlibDeflate(data: Uint8Array, options: DeflateOptions): Uint8Array {
  return pako.deflate(data, { level: options.level, memLevel: options.memLevel ?? 9, strategy: options.strategy ?? Z_DEFAULT_STRATEGY });
}

export function zlibInflate(data: Uint8Array): Uint8Array {
  return pako.inflate(data);
}
