import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { IR_VERSION, type Asset, type Deck, type ImageElement, type Slide } from '../../src/ir/types';
import { PdfCancelledError, dedupePdfObjects, imageDeckToPdf, imagePageSize, mergePdfs, pdfImageOrigin } from '../../src/ui/pdf';

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

/** Deterministic noise (incompressible, so the image dominates the file size). */
function noisePng(width: number, height: number, seed: number, alpha = false): Uint8Array {
  const p = new PNG({ width, height });
  let x = seed >>> 0 || 1;
  for (let i = 0; i < p.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      p.data[i + c] = x & 255;
    }
    p.data[i + 3] = alpha && (i / 4) % 7 === 0 ? 128 : 255;
  }
  return new Uint8Array(PNG.sync.write(p, { colorType: alpha ? 6 : 2 }));
}

/** A one-page PDF with `png` drawn full page and a line of Helvetica text (like one Figma frame export). */
async function framePdf(png: Uint8Array, w: number, h: number, text = 'Startup Summit'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([w, h]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  page.drawText(text, { x: 20, y: 20, size: 24, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save();
}

function streamsOfSubtype(doc: PDFDocument, subtype: string): PDFRawStream[] {
  return doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of(subtype));
}

function dictsOfType(doc: PDFDocument, type: string): PDFDict[] {
  return doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.Type) === PDFName.of(type));
}

/** The indirect ref each page uses for its (single) image XObject. */
function pageImageRefs(doc: PDFDocument): string[] {
  return doc.getPages().map((p) => {
    const xobjects = p.node.Resources()!.lookup(PDFName.XObject, PDFDict);
    const ref = xobjects.values().find((v) => v instanceof PDFRef) as PDFRef;
    return ref.tag;
  });
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
    const doc = await PDFDocument.load(out.data, { updateMetadata: false });
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

describe('mergePdfs: duplicate resources', () => {
  const photo = noisePng(160, 120, 7);

  it('the same image embedded in every frame PDF is stored once', async () => {
    const a = await framePdf(photo, 4992, 1536);
    const b = await framePdf(photo, 4992, 1536, 'Agenda');
    const plain = await mergePdfs([a, b], {}, { yieldFn: noYield }, undefined, { dedupe: false });
    const out = await mergePdfs([a, b], {}, { yieldFn: noYield });

    const before = await PDFDocument.load(plain.data);
    expect(streamsOfSubtype(before, 'Image')).toHaveLength(2);
    expect(plain.dedupe).toEqual({ objects: 0, bytes: 0 });

    const doc = await PDFDocument.load(out.data);
    expect(streamsOfSubtype(doc, 'Image')).toHaveLength(1);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [4992, 1536],
      [4992, 1536],
    ]);
    // Both pages draw the kept image.
    const refs = pageImageRefs(doc);
    expect(refs[0]).toBe(refs[1]);
    // The file is roughly one image lighter: much smaller than the sum of the parts.
    expect(out.data.byteLength).toBeLessThan(0.6 * (a.byteLength + b.byteLength));
    expect(out.data.byteLength).toBeLessThan(0.6 * plain.data.byteLength);
    expect(out.dedupe.objects).toBeGreaterThanOrEqual(1);
    expect(out.dedupe.bytes).toBeGreaterThan(photo.byteLength * 0.8);
    expect(out.dedupe.bytes).toBeLessThan(plain.data.byteLength);
  });

  it('merges chains: identical soft masks first, then the images and fonts that reference them', async () => {
    const translucent = noisePng(96, 64, 11, true);
    const parts = await Promise.all([1, 2, 3].map((i) => framePdf(translucent, 1920, 1080, `Slide ${i}`)));
    const out = await mergePdfs(parts, {}, { yieldFn: noYield });
    const doc = await PDFDocument.load(out.data);
    // One colour image + its one soft mask (instead of 3 + 3), one Helvetica font dict (instead of 3).
    expect(streamsOfSubtype(doc, 'Image')).toHaveLength(2);
    expect(dictsOfType(doc, 'Font')).toHaveLength(1);
    expect(doc.getPageCount()).toBe(3);
    const refs = pageImageRefs(doc);
    expect(new Set(refs).size).toBe(1);
    const kept = doc.context.lookup(PDFRef.of(Number(refs[0].split(' ')[0])));
    expect(kept).toBeInstanceOf(PDFRawStream);
    expect((kept as PDFRawStream).dict.get(PDFName.of('SMask'))).toBeInstanceOf(PDFRef);
  });

  it('keeps different images apart and identical pages as separate pages', async () => {
    const a = await framePdf(noisePng(64, 64, 1), 800, 600, 'Same');
    const b = await framePdf(noisePng(64, 64, 2), 800, 600, 'Same');
    const doc = await PDFDocument.load((await mergePdfs([a, b, a], {}, { yieldFn: noYield })).data);
    expect(streamsOfSubtype(doc, 'Image')).toHaveLength(2);
    expect(doc.getPageCount()).toBe(3);
    const pageRefs = doc.getPages().map((p) => p.ref.tag);
    expect(new Set(pageRefs).size).toBe(3);
    const refs = pageImageRefs(doc);
    expect(refs[0]).not.toBe(refs[1]);
    expect(refs[0]).toBe(refs[2]);
  });

  it('dedupePdfObjects reports nothing for a document without duplicates', async () => {
    const doc = await PDFDocument.load(await framePdf(photo, 100, 100));
    expect(dedupePdfObjects(doc)).toEqual({ objects: 0, bytes: 0 });
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

  it('page size = frame px as pt, capped at the PDF limit with uniform scaling', () => {
    expect(imagePageSize(4992, 1536)).toEqual({ width: 4992, height: 1536, scale: 1 });
    const big = imagePageSize(28800, 7200);
    expect(big.scale).toBe(0.5);
    expect([big.width, big.height]).toEqual([CONFIG.pdf.maxPageSidePt, 3600]);
    const tall = imagePageSize(1000, 20000);
    expect(tall.height).toBeCloseTo(CONFIG.pdf.maxPageSidePt, 9);
    expect(tall.width).toBeCloseTo(720, 9);
  });

  it('scales oversized slides and their pictures to the page limit', async () => {
    const huge: Deck = {
      irVersion: IR_VERSION,
      meta: { title: 'LED' },
      slides: [{ id: 'big', name: 'Wall', width: 28800, height: 7200, background: null, elements: [image('full', 'bg', 0, 0, 28800, 7200)] }],
      assets,
      report: [],
    };
    const res = await imageDeckToPdf(huge, {}, { yieldFn: noYield });
    const doc = await PDFDocument.load(res.data);
    expect([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()]).toEqual([14400, 3600]);
    expect(res.report).toEqual([expect.objectContaining({ level: 'info', code: 'pdf-page-scaled', slideId: 'big' })]);
    // The picture covers the whole (scaled) page.
    const contents = doc.getPage(0).node.Contents();
    const stream = contents instanceof PDFRawStream ? contents : (doc.context.lookup((contents as PDFArray).get(0) as PDFRef) as PDFRawStream);
    const ops = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    expect(ops).toContain('14400 0 0 3600 0 0 cm');
  });

  it('embeds JPEG assets as they are (DCTDecode, quality chosen by the image step)', async () => {
    // Minimal JPEG header (SOI, SOF0 32×16 3 channels, EOI): pdf-lib reads the size and copies the bytes.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
    const d: Deck = {
      irVersion: IR_VERSION,
      meta: { title: 'J' },
      slides: [{ id: 'j', name: 'J', width: 320, height: 160, background: null, elements: [image('p', 'jpg', 0, 0, 320, 160)] }],
      assets: { jpg: { id: 'jpg', mime: 'image/jpeg', role: 'background', data: jpeg, width: 32, height: 16 } },
      report: [],
    };
    const res = await imageDeckToPdf(d, {}, { yieldFn: noYield });
    const doc = await PDFDocument.load(res.data);
    const [img] = streamsOfSubtype(doc, 'Image');
    expect(img.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
    expect([...img.contents]).toEqual([...jpeg]);
  });

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
