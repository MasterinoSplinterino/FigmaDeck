import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { IR_VERSION, type Asset, type Deck, type ImageElement, type Slide } from '../../src/ir/types';
import { PdfCancelledError, imageDeckToPdf, mergePdfs, pdfImageOrigin } from '../../src/ui/pdf';

const noYield = () => Promise.resolve();

async function pdfWithPages(sizes: Array<[number, number]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  return doc.save();
}

function png(width: number, height: number): Uint8Array {
  const p = new PNG({ width, height });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = 200;
    p.data[i + 1] = 40;
    p.data[i + 2] = 90;
    p.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(p));
}

function image(id: string, assetId: string, x: number, y: number, w: number, h: number, rotation = 0): ImageElement {
  return {
    type: 'image',
    id,
    name: id,
    transform: { x, y, w, h, rotation, flipH: false, flipV: false },
    opacity: 1,
    assetId,
    crop: null,
    geometry: 'rect',
    cornerRadius: 0,
  };
}

describe('mergePdfs', () => {
  it('concatenates all pages in order and writes our metadata', async () => {
    const a = await pdfWithPages([[1920, 1080]]);
    const b = await pdfWithPages([
      [1080, 1080],
      [595, 842],
    ]);
    const progress: number[] = [];
    const out = await mergePdfs([a, b], { title: 'Deck', author: 'Ann', company: 'ACME' }, { yieldFn: noYield, onProgress: (d) => progress.push(d) }, new Date('2026-01-02T03:04:05Z'));
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [1920, 1080],
      [1080, 1080],
      [595, 842],
    ]);
    expect(doc.getTitle()).toBe('Deck');
    expect(doc.getAuthor()).toBe('Ann');
    expect(doc.getSubject()).toBe('ACME');
    expect(doc.getProducer()).toBe(CONFIG.meta.application);
    expect(doc.getCreator()).toBe(CONFIG.meta.application);
    expect(progress).toEqual([0, 1, 2]);
  });

  it('can be cancelled between parts', async () => {
    const a = await pdfWithPages([[100, 100]]);
    await expect(mergePdfs([a, a], {}, { yieldFn: noYield, isCancelled: () => true })).rejects.toBeInstanceOf(PdfCancelledError);
  });
});

describe('pdfImageOrigin', () => {
  it('unrotated: flips y (PDF origin is bottom-left)', () => {
    expect(pdfImageOrigin(10, 20, 100, 50, 0, 200)).toEqual({ x: 10, y: 130 });
  });

  it('90° clockwise keeps the box center', () => {
    const o = pdfImageOrigin(0, 0, 100, 50, 90, 200);
    expect(o.x).toBeCloseTo(25, 9);
    expect(o.y).toBeCloseTo(225, 9);
  });

  it('180°: origin at the opposite corner', () => {
    const o = pdfImageOrigin(0, 0, 100, 50, 180, 200);
    expect(o.x).toBeCloseTo(100, 9);
    expect(o.y).toBeCloseTo(200, 9);
  });
});

describe('imageDeckToPdf', () => {
  const pngBytes = png(64, 36);
  const assets: Record<string, Asset> = {
    bg: { id: 'bg', mime: 'image/png', role: 'background', data: pngBytes, width: 64, height: 36 },
    anim: { id: 'anim', mime: 'image/gif', role: 'image-fill', data: new Uint8Array([71, 73, 70]), width: 1, height: 1 },
  };
  const slides: Slide[] = [
    { id: 's1', name: 'One', width: 1920, height: 1080, background: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, elements: [image('i1', 'bg', 0, 0, 1920, 1080)] },
    {
      id: 's2',
      name: 'Two',
      width: 1080,
      height: 1080,
      background: null,
      elements: [
        { type: 'group', id: 'g', name: 'g', transform: { x: 0, y: 0, w: 1080, h: 1080, rotation: 0, flipH: false, flipV: false }, opacity: 1, children: [image('i2', 'bg', 0, 0, 1080, 608)] },
        image('i3', 'anim', 0, 0, 10, 10),
        image('i4', 'missing', 0, 0, 10, 10),
        { type: 'shape', id: 'sh', name: 'sh', transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, flipH: false, flipV: false }, opacity: 1, geometry: 'rect', cornerRadius: 0, fill: null, stroke: null },
      ],
    },
  ];
  const deck: Deck = { irVersion: IR_VERSION, meta: { title: 'Deck' }, slides, assets, report: [] };

  it('one page per slide at frame size, pictures embedded once', async () => {
    const res = await imageDeckToPdf(deck, { title: 'Deck' }, { yieldFn: noYield });
    const doc = await PDFDocument.load(res.data);
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [1920, 1080],
      [1080, 1080],
    ]);
    expect(doc.getTitle()).toBe('Deck');
    // PNG embedded once although drawn twice.
    const text = Buffer.from(res.data).toString('latin1');
    expect(text.match(/\/Subtype \/Image/g)?.length).toBe(1);
  });

  it('reports what an image PDF cannot draw', async () => {
    const res = await imageDeckToPdf(deck, {}, { yieldFn: noYield });
    expect(res.report).toHaveLength(1);
    expect(res.report[0]).toMatchObject({ level: 'warning', code: 'pdf-image-skipped', slideId: 's2' });
    expect(res.report[0].message).toContain('3 non-picture');
  });

  it('can be cancelled', async () => {
    await expect(imageDeckToPdf(deck, {}, { yieldFn: noYield, isCancelled: () => true })).rejects.toBeInstanceOf(PdfCancelledError);
  });
});
