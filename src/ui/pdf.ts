/**
 * PDF assembly with pdf-lib (runs in the UI iframe and in Node tests):
 * - `mergePdfs`: Figma's per-frame vector PDFs → one document;
 * - `imageDeckToPdf`: an "Image only" IR deck → one page per slide (page size = frame px as pt).
 */
import { PDFDocument, degrees, rgb, type PDFImage, type PDFPage } from 'pdf-lib';
import { CONFIG } from '../config';
import type { Deck, Element, ImageElement, ReportEntry } from '../ir/types';

export interface PdfMeta {
  title?: string;
  author?: string;
  company?: string;
}

export interface PdfHooks {
  onProgress?: (done: number, total: number) => void;
  /** Checked between pages; when true the operation rejects with `PdfCancelledError`. */
  isCancelled?: () => boolean;
  yieldFn?: () => Promise<void>;
}

export class PdfCancelledError extends Error {
  constructor() {
    super('PDF assembly cancelled');
    this.name = 'PdfCancelledError';
  }
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function applyMeta(doc: PDFDocument, meta: PdfMeta, now: Date): void {
  if (meta.title) doc.setTitle(meta.title, { showInWindowTitleBar: true });
  if (meta.author) doc.setAuthor(meta.author);
  if (meta.company) doc.setSubject(meta.company);
  doc.setCreator(CONFIG.meta.application);
  doc.setProducer(CONFIG.meta.application);
  doc.setCreationDate(now);
  doc.setModificationDate(now);
}

/** Concatenate PDFs (all pages of each, in order). */
export async function mergePdfs(parts: readonly Uint8Array[], meta: PdfMeta, hooks: PdfHooks = {}, now: Date = new Date()): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const pause = hooks.yieldFn ?? macrotask;
  hooks.onProgress?.(0, parts.length);
  for (let i = 0; i < parts.length; i++) {
    if (hooks.isCancelled?.()) throw new PdfCancelledError();
    const src = await PDFDocument.load(parts[i], { updateMetadata: false, ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
    hooks.onProgress?.(i + 1, parts.length);
    await pause();
  }
  applyMeta(out, meta, now);
  return out.save();
}

function collectImages(elements: readonly Element[], out: ImageElement[], skipped: { count: number }): void {
  for (const e of elements) {
    if (e.type === 'image') out.push(e);
    else if (e.type === 'group') collectImages(e.children, out, skipped);
    else skipped.count++;
  }
}

/**
 * Bottom-left corner (PDF user space, y up) for drawing a w×h picture rotated clockwise by
 * `rotationCw` degrees around its box center, when the box's top-left is (x, y) in slide px (y down).
 */
export function pdfImageOrigin(x: number, y: number, w: number, h: number, rotationCw: number, pageHeight: number): { x: number; y: number } {
  const cx = x + w / 2;
  const cy = pageHeight - (y + h / 2);
  const a = (-rotationCw * Math.PI) / 180; // PDF rotates counter-clockwise
  const dx = -w / 2;
  const dy = -h / 2;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

function drawImage(page: PDFPage, img: PDFImage, e: ImageElement, pageHeight: number): void {
  const { x, y, w, h, rotation } = e.transform;
  const origin = pdfImageOrigin(x, y, w, h, rotation, pageHeight);
  page.drawImage(img, {
    x: origin.x,
    y: origin.y,
    width: w,
    height: h,
    rotate: degrees(-rotation),
    opacity: Math.max(0, Math.min(1, e.opacity)),
  });
}

export interface ImagePdfResult {
  data: Uint8Array;
  /** Warnings (non-image content that a picture PDF cannot show). */
  report: ReportEntry[];
}

/**
 * One page per slide with the slide's pictures (crop / flips are not applied: "Image only" slides
 * are a single unrotated full-slide picture). Page size in pt = frame size in px.
 */
export async function imageDeckToPdf(deck: Deck, meta: PdfMeta, hooks: PdfHooks = {}, now: Date = new Date()): Promise<ImagePdfResult> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pause = hooks.yieldFn ?? macrotask;
  const embedded = new Map<string, PDFImage>();
  const report: ReportEntry[] = [];
  const total = deck.slides.length;
  hooks.onProgress?.(0, total);
  for (let i = 0; i < total; i++) {
    if (hooks.isCancelled?.()) throw new PdfCancelledError();
    const slide = deck.slides[i];
    const page = doc.addPage([slide.width, slide.height]);
    if (slide.background) {
      const c = slide.background.color;
      page.drawRectangle({ x: 0, y: 0, width: slide.width, height: slide.height, color: rgb(c.r, c.g, c.b), opacity: c.a });
    }
    const images: ImageElement[] = [];
    const skipped = { count: 0 };
    collectImages(slide.elements, images, skipped);
    for (const e of images) {
      const asset = deck.assets[e.assetId];
      if (!asset) {
        skipped.count++;
        continue;
      }
      let img = embedded.get(asset.id);
      if (!img) {
        if (asset.mime === 'image/png') img = await doc.embedPng(asset.data);
        else if (asset.mime === 'image/jpeg') img = await doc.embedJpg(asset.data);
        else {
          skipped.count++;
          continue;
        }
        embedded.set(asset.id, img);
      }
      drawImage(page, img, e, slide.height);
    }
    if (skipped.count > 0) {
      report.push({
        level: 'warning',
        code: 'pdf-image-skipped',
        slideId: slide.id,
        slideName: slide.name,
        message: `${skipped.count} non-picture element(s) could not be drawn into the image PDF.`,
      });
    }
    hooks.onProgress?.(i + 1, total);
    await pause();
  }
  applyMeta(doc, meta, now);
  return { data: await doc.save(), report };
}
