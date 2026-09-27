import { describe, expect, it } from 'vitest';
import { bitDepthFor, crc32, encodeIndexedPng, encodeTruecolorPng, filterImage, type PngEncodeOptions } from '../../src/compress/png-encode';
import { zlibInflate } from '../../src/compress/zlib';
import { decodePngjs, decodeUpng, ihdr, readChunks } from './helpers';

const OPTS: PngEncodeOptions = { level: 9, attempts: [{ filter: 'none', strategy: 'default' }] };

/** Palette of `n` entries: straight RGBA, entry i = (i*7, 255 − i, i*3, alpha(i)). */
function palette(n: number, alpha: (i: number) => number = () => 255): Uint8Array {
  const p = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) p.set([(i * 7) & 255, 255 - i, (i * 3) & 255, alpha(i)], i * 4);
  return p;
}

function indicesUsingAll(width: number, height: number, n: number): Uint8Array {
  const idx = new Uint8Array(width * height);
  for (let i = 0; i < idx.length; i++) idx[i] = i % n;
  return idx;
}

describe('crc32', () => {
  it('matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('encodeIndexedPng', () => {
  it('chooses the smallest bit depth for the palette size', () => {
    expect([2, 3, 4, 5, 16, 17, 256].map(bitDepthFor)).toEqual([1, 2, 2, 4, 4, 8, 8]);
    for (const [n, depth] of [
      [2, 1],
      [4, 2],
      [9, 4],
      [16, 4],
      [17, 8],
      [256, 8],
    ] as const) {
      const w = 13; // not a multiple of the pixels per byte: exercises row padding
      const h = 5;
      const pal = palette(n);
      const idx = indicesUsingAll(w, h, n);
      const png = encodeIndexedPng(idx, w, h, pal, n, OPTS);
      expect(png.bitDepth).toBe(depth);
      expect(ihdr(png.bytes)).toEqual({ width: w, height: h, bitDepth: depth, colorType: 3 });
      // Exact round trip through two independent decoders.
      for (const dec of [decodePngjs(png.bytes), decodeUpng(png.bytes)]) {
        expect([dec.width, dec.height]).toEqual([w, h]);
        for (let i = 0; i < w * h; i++) expect(Array.from(dec.data.subarray(i * 4, i * 4 + 4))).toEqual(Array.from(pal.subarray(idx[i] * 4, idx[i] * 4 + 4)));
      }
    }
  });

  it('orders non-opaque entries first and trims tRNS after the last one', () => {
    // Entries 1, 4 and 6 are translucent, 3 fully transparent; the rest opaque.
    const alphas = [255, 128, 255, 0, 40, 255, 200, 255];
    const pal = palette(8, (i) => alphas[i]);
    const idx = indicesUsingAll(8, 4, 8);
    const png = encodeIndexedPng(idx, 8, 4, pal, 8, OPTS);
    const chunks = readChunks(png.bytes);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    const trns = chunks.find((c) => c.type === 'tRNS')!;
    expect(png.transparentEntries).toBe(4);
    expect(Array.from(trns.data)).toEqual([0, 40, 128, 200]); // sorted by alpha, opaque ones omitted
    const dec = decodePngjs(png.bytes);
    for (let i = 0; i < idx.length; i++) {
      const src = pal.subarray(idx[i] * 4, idx[i] * 4 + 4);
      const got = dec.data.subarray(i * 4, i * 4 + 4);
      expect(got[3]).toBe(src[3]);
      if (src[3] !== 0) expect(Array.from(got)).toEqual(Array.from(src));
    }
  });

  it('writes no tRNS for an opaque palette and drops unused entries', () => {
    const pal = palette(40);
    const idx = new Uint8Array(30 * 3).map((_, i) => [0, 5, 39][i % 3]);
    const png = encodeIndexedPng(idx, 30, 3, pal, 40, OPTS);
    const types = readChunks(png.bytes).map((c) => c.type);
    expect(types).not.toContain('tRNS');
    expect(png.colors).toBe(3);
    expect(png.bitDepth).toBe(2);
    expect(readChunks(png.bytes)[1].data.length).toBe(9);
  });

  it('writes correct CRCs and a valid zlib stream', () => {
    const pal = palette(20, (i) => (i < 5 ? i * 50 : 255));
    const png = encodeIndexedPng(indicesUsingAll(33, 17, 20), 33, 17, pal, 20, OPTS);
    const chunks = readChunks(png.bytes);
    expect(Array.from(png.bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const c of chunks) expect(c.crc).toBe(crc32(png.bytes, c.offset, c.offset + 4 + c.data.length));
    const idat = chunks.find((c) => c.type === 'IDAT')!;
    const raw = zlibInflate(idat.data);
    expect(raw.length).toBe(17 * (1 + 33)); // 8-bit indices, one filter byte per row
    for (let y = 0; y < 17; y++) expect(raw[y * 34]).toBe(0); // filter 0
    expect(() => decodePngjs(png.bytes)).not.toThrow(); // pngjs verifies CRCs
    expect(chunks.map((c) => c.type)).not.toContain('tEXt');
  });

  it('rejects indices outside the palette', () => {
    expect(() => encodeIndexedPng(new Uint8Array([0, 1, 5]), 3, 1, palette(3), 3, OPTS)).toThrow(RangeError);
  });

  it('uses the best of several filter attempts', () => {
    const idx = indicesUsingAll(64, 64, 200);
    const pal = palette(200);
    const none = encodeIndexedPng(idx, 64, 64, pal, 200, OPTS).bytes.length;
    const both = encodeIndexedPng(idx, 64, 64, pal, 200, { level: 9, attempts: [{ filter: 'none', strategy: 'default' }, { filter: 'adaptive', strategy: 'default' }], rankLevel: 1 }).bytes.length;
    expect(both).toBeLessThanOrEqual(none);
  });
});

describe('encodeTruecolorPng', () => {
  it('writes colour type 2 when opaque and round-trips exactly', () => {
    const w = 21;
    const h = 9;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([(i * 37) & 255, (i * 11) & 255, (i * 101) & 255, 255], i * 4);
    const bytes = encodeTruecolorPng(rgba, w, h, { level: 6, attempts: [{ filter: 'adaptive', strategy: 'default' }] });
    expect(ihdr(bytes)).toEqual({ width: w, height: h, bitDepth: 8, colorType: 2 });
    expect(Array.from(decodePngjs(bytes).data)).toEqual(Array.from(rgba));
  });

  it('writes colour type 6 with alpha, zeroing the RGB of fully transparent pixels', () => {
    const w = 10;
    const h = 10;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([(i * 13) & 255, 200, (i * 7) & 255, i % 3 === 0 ? 0 : (i * 5) & 255], i * 4);
    for (const filter of ['none', 'sub', 'up', 'paeth', 'adaptive'] as const) {
      const bytes = encodeTruecolorPng(rgba, w, h, { level: 6, attempts: [{ filter, strategy: 'default' }] });
      expect(ihdr(bytes).colorType).toBe(6);
      const dec = decodeUpng(bytes).data;
      for (let i = 0; i < w * h; i++) {
        const a = rgba[i * 4 + 3];
        expect(dec[i * 4 + 3]).toBe(a);
        if (a !== 0) expect(Array.from(dec.subarray(i * 4, i * 4 + 3))).toEqual(Array.from(rgba.subarray(i * 4, i * 4 + 3)));
        else expect(Array.from(dec.subarray(i * 4, i * 4 + 3))).toEqual([0, 0, 0]);
      }
    }
  });

  it('ranks filters on sampled row bands and still encodes the whole image exactly', () => {
    const w = 64;
    const h = 200;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([(i * 5) & 255, (i >> 3) & 255, (i * 9) & 255, 255], i * 4);
    // Sampled rows are filtered exactly like in the full image (each from its real previous row).
    const raw = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) raw.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
    const full = filterImage(raw, w * 3, h, 3, 'adaptive');
    const rows = [0, 1, 50, 51, 199];
    const part = filterImage(raw, w * 3, h, 3, 'adaptive', rows);
    rows.forEach((y, k) => expect(Array.from(part.subarray(k * (w * 3 + 1), (k + 1) * (w * 3 + 1)))).toEqual(Array.from(full.subarray(y * (w * 3 + 1), (y + 1) * (w * 3 + 1)))));
    const bytes = encodeTruecolorPng(rgba, w, h, {
      level: 6,
      attempts: [{ filter: 'none', strategy: 'default' }, { filter: 'sub', strategy: 'default' }, { filter: 'adaptive', strategy: 'default' }],
      rankLevel: 1,
      rankSampleBytes: 2000,
    });
    expect(Array.from(decodePngjs(bytes).data)).toEqual(Array.from(rgba));
  });
});
