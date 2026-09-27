import { describe, expect, it } from 'vitest';
import { sortByCanvasOrder } from '../../src/extract/order';
import { readPngInfo, readSvgSize, setSvgViewport, sniffImageMime } from '../../src/extract/png';
import { JPEG_BYTES, WEBP_BYTES, ascii, makePng } from '../helpers/figma-mocks';

const item = (id: string, x: number, y: number, pageIndex = 0, width = 100, height = 100) => ({ id, x, y, width, height, pageIndex });

describe('canvas order', () => {
  it('rows with tolerance (half the smaller height), then x', () => {
    const items = [item('c', 300, 40), item('a', 0, 0), item('b', 150, 30), item('d', 0, 200), item('e', 120, 180)];
    expect(sortByCanvasOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a frame lower than the tolerance starts a new row', () => {
    const items = [item('a', 200, 0), item('b', 0, 60)];
    expect(sortByCanvasOrder(items).map((i) => i.id)).toEqual(['a', 'b']);
    expect(sortByCanvasOrder(items, 0.7).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('uses the smaller height of the pair', () => {
    // Tall frame (h 1000) and a small one (h 20) 30 px lower: 30 > 0.5 × 20 → new row.
    const items = [item('tall', 500, 0, 0, 100, 1000), item('small', 0, 30, 0, 100, 20)];
    expect(sortByCanvasOrder(items).map((i) => i.id)).toEqual(['tall', 'small']);
  });

  it('page order first, stable for equal positions', () => {
    const items = [item('p1', 0, 0, 1), item('p0b', 0, 0, 0), item('p0a', 0, 0, 0)];
    expect(sortByCanvasOrder(items).map((i) => i.id)).toEqual(['p0b', 'p0a', 'p1']);
  });

  it('does not mutate the input', () => {
    const items = [item('b', 10, 0), item('a', 0, 0)];
    sortByCanvasOrder(items);
    expect(items.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('PNG header', () => {
  it('reads size and alpha by color type', () => {
    expect(readPngInfo(makePng(300, 200))).toEqual({ width: 300, height: 200, bitDepth: 8, colorType: 6, hasAlpha: true });
    expect(readPngInfo(makePng(3, 2, { colorType: 2 }))?.hasAlpha).toBe(false);
    expect(readPngInfo(makePng(3, 2, { colorType: 3 }))?.hasAlpha).toBe(false);
  });

  it('tRNS before IDAT means alpha', () => {
    expect(readPngInfo(makePng(3, 2, { colorType: 3, tRNS: true }))?.hasAlpha).toBe(true);
    expect(readPngInfo(makePng(3, 2, { colorType: 2, tRNS: true }))?.hasAlpha).toBe(true);
  });

  it('rejects non-PNG data', () => {
    expect(readPngInfo(JPEG_BYTES)).toBeNull();
    expect(readPngInfo(new Uint8Array(0))).toBeNull();
    expect(readPngInfo(makePng(2, 2).subarray(0, 20))).toBeNull();
  });

  it('sniffs image formats by magic number', () => {
    expect(sniffImageMime(makePng(1, 1))).toBe('image/png');
    expect(sniffImageMime(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageMime(ascii('GIF89a....'))).toBe('image/gif');
    expect(sniffImageMime(WEBP_BYTES)).toBeNull();
  });

  it('reads SVG root sizes', () => {
    expect(readSvgSize(ascii('<svg width="24" height="16.5" viewBox="0 0 24 16.5">'))).toEqual({ width: 24, height: 16.5 });
    expect(readSvgSize(ascii("<?xml version='1.0'?><svg xmlns='x' width='10px' height='20px'>"))).toEqual({ width: 10, height: 20 });
    expect(readSvgSize(ascii('<svg viewBox="0 0 40 30">'))).toEqual({ width: 40, height: 30 });
    expect(readSvgSize(ascii('<html>'))).toBeNull();
  });

  it('rewrites the SVG root viewport to the picture box, keeping everything else byte for byte', () => {
    const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
    const svg = ascii('<?xml?><svg width="21" height="11" viewBox="0 0 21 11" fill="none" xmlns="x"><path d="M0 0" stroke-width="2"/>\xe9</svg>');
    const out = setSvgViewport(svg, 20.5, 10.5)!;
    expect(latin1(out)).toBe('<?xml?><svg width="20.5" height="10.5" viewBox="0 0 20.5 10.5" fill="none" xmlns="x"><path d="M0 0" stroke-width="2"/>\xe9</svg>');
    expect(readSvgSize(out)).toEqual({ width: 20.5, height: 10.5 });
    // Missing attributes are added; a viewBox origin is kept.
    expect(latin1(setSvgViewport(ascii("<svg viewBox='5 6 7 8'>"), 3, 4)!)).toBe('<svg height="4" width="3" viewBox="5 6 3 4">');
    expect(setSvgViewport(ascii('<html>'), 1, 1)).toBeNull();
  });
});
