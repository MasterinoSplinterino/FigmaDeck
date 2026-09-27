/**
 * PDF assembly with pdf-lib (runs in the UI iframe and in Node tests):
 * - `mergePdfs`: Figma's per-frame vector PDFs → one document. Figma embeds every resource (a
 *   background photo, a logo, font programs, ICC profiles…) once PER FRAME, so a deck repeating the
 *   same picture on 30 slides carries it 30 times. `dedupePdfObjects` keeps one copy of every
 *   byte-identical indirect object and points all references to it.
 * - `imageDeckToPdf`: an "Image only" IR deck → one page per slide (page size = frame px as pt,
 *   capped at CONFIG.pdf.maxPageSidePt).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  degrees,
  rgb,
  type PDFImage,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib';
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

// ─── Duplicate resources ─────────────────────────────────────────────────────

export interface DedupeStats {
  /** Indirect objects removed because an identical one was kept. */
  objects: number;
  /** Size of the removed objects (stream data + dictionaries), ≈ bytes saved in the file. */
  bytes: number;
}

/**
 * Non-stream dictionaries that are pure resources and may be shared (by `/Type`). Structural objects
 * (pages, page tree, catalog, annotations, outlines…) are never merged: two identical pages must stay
 * two pages.
 */
const SHAREABLE_DICT_TYPES: ReadonlySet<string> = new Set(['Font', 'FontDescriptor', 'ExtGState', 'Encoding', 'Pattern', 'Mask', 'Halftone']);
/** Resource dictionaries without `/Type` recognized by a key (functions, shadings, patterns). */
const SHAREABLE_DICT_KEYS: readonly PDFName[] = [PDFName.of('FunctionType'), PDFName.of('ShadingType'), PDFName.of('PatternType')];

function isShareableDict(d: PDFDict): boolean {
  const type = d.get(PDFName.Type);
  if (type instanceof PDFName) return SHAREABLE_DICT_TYPES.has(type.decodeText());
  return SHAREABLE_DICT_KEYS.some((k) => d.has(k));
}

/** FNV-1a (32 bit). Only buckets candidates; equality is always confirmed byte by byte. */
function hashBytes(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Stream dictionary as text with `/Length` left out (it may be an indirect reference; equal contents
 * have equal lengths anyway). References print as "12 0 R", so after a rewrite pass two dictionaries
 * that point to the same (kept) objects print identically.
 */
function streamDictKey(d: PDFDict): string {
  let s = '';
  for (const [k, v] of d.entries()) {
    if (k === PDFName.Length) continue;
    s += `${k.toString()} ${v.toString()}\n`;
  }
  return s;
}

interface Candidate {
  ref: PDFRef;
  obj: PDFObject;
}

/** Bucket key of an object that may be merged, or null. */
function dedupeKey(obj: PDFObject, hashes: WeakMap<PDFRawStream, number>): string | null {
  if (obj instanceof PDFRawStream) {
    let h = hashes.get(obj);
    if (h === undefined) {
      h = hashBytes(obj.contents);
      hashes.set(obj, h);
    }
    return `S|${obj.contents.length}|${h}|${streamDictKey(obj.dict)}`;
  }
  if (obj instanceof PDFArray) return `A|${obj.toString()}`;
  if (obj instanceof PDFDict && isShareableDict(obj)) return `D|${obj.toString()}`;
  return null;
}

/** Same bucket key → identical, except for streams whose contents must be compared. */
function sameObject(a: PDFObject, b: PDFObject): boolean {
  if (a instanceof PDFRawStream && b instanceof PDFRawStream) return bytesEqual(a.contents, b.contents);
  return true;
}

function removedSize(obj: PDFObject): number {
  if (obj instanceof PDFRawStream) return obj.contents.length + streamDictKey(obj.dict).length;
  return obj.toString().length;
}

/** Replace every reference to a key of `replace` inside `obj` (dicts, arrays, stream dicts, nested). */
function rewriteRefs(obj: PDFObject, replace: ReadonlyMap<string, PDFRef>): void {
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      if (v instanceof PDFRef) {
        const to = replace.get(v.tag);
        if (to) obj.set(k, to);
      } else rewriteRefs(v, replace);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      if (v instanceof PDFRef) {
        const to = replace.get(v.tag);
        if (to) obj.set(i, to);
      } else rewriteRefs(v, replace);
    }
  } else if (obj instanceof PDFStream) {
    rewriteRefs(obj.dict, replace);
  }
}

/**
 * Keep one copy of every byte-identical indirect stream (images, soft masks, font programs, ICC
 * profiles, identical content streams…) and of identical resource arrays / dictionaries, rewrite all
 * references to the kept object (lowest object number) and delete the duplicates.
 *
 * Runs in passes until nothing changes: merging two identical soft masks makes the two images that
 * reference them identical, merging two font files makes their descriptors identical, and so on.
 */
export function dedupePdfObjects(doc: PDFDocument, maxPasses: number = CONFIG.pdf.dedupeMaxPasses): DedupeStats {
  const context = doc.context;
  const stats: DedupeStats = { objects: 0, bytes: 0 };
  const hashes = new WeakMap<PDFRawStream, number>();
  for (let pass = 0; pass < maxPasses; pass++) {
    const buckets = new Map<string, Candidate[]>();
    const replace = new Map<string, PDFRef>();
    const duplicates: PDFRef[] = [];
    // Sorted by object number: the first occurrence is kept.
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      const key = dedupeKey(obj, hashes);
      if (key === null) continue;
      const bucket = buckets.get(key);
      const keep = bucket?.find((c) => sameObject(c.obj, obj));
      if (keep) {
        replace.set(ref.tag, keep.ref);
        duplicates.push(ref);
        stats.objects++;
        stats.bytes += removedSize(obj);
      } else if (bucket) bucket.push({ ref, obj });
      else buckets.set(key, [{ ref, obj }]);
    }
    if (duplicates.length === 0) break;
    for (const ref of duplicates) context.delete(ref);
    for (const [, obj] of context.enumerateIndirectObjects()) rewriteRefs(obj, replace);
  }
  return stats;
}

export interface MergeResult {
  data: Uint8Array;
  /** Duplicate resources removed from the merged file. */
  dedupe: DedupeStats;
}

export interface MergeOptions {
  /** Default CONFIG.pdf.dedupeResources. */
  dedupe?: boolean;
}

/** Concatenate PDFs (all pages of each, in order), merge duplicate resources, save with object streams. */
export async function mergePdfs(
  parts: readonly Uint8Array[],
  meta: PdfMeta,
  hooks: PdfHooks = {},
  now: Date = new Date(),
  options: MergeOptions = {},
): Promise<MergeResult> {
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
  if (hooks.isCancelled?.()) throw new PdfCancelledError();
  const dedupe = (options.dedupe ?? CONFIG.pdf.dedupeResources) ? dedupePdfObjects(out) : { objects: 0, bytes: 0 };
  applyMeta(out, meta, now);
  return { data: await out.save({ useObjectStreams: true }), dedupe };
}

// ─── Image PDF ───────────────────────────────────────────────────────────────

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

/** Page size (pt) and the frame px → pt factor: 1 px = 1 pt, uniformly scaled to fit `maxSide`. */
export function imagePageSize(width: number, height: number, maxSide: number = CONFIG.pdf.maxPageSidePt): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: width * scale, height: height * scale, scale };
}

function drawImage(page: PDFPage, img: PDFImage, e: ImageElement, scale: number, pageHeight: number): void {
  const { rotation } = e.transform;
  const x = e.transform.x * scale;
  const y = e.transform.y * scale;
  const w = e.transform.w * scale;
  const h = e.transform.h * scale;
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
  /** Warnings (non-image content that a picture PDF cannot show) and notes (pages scaled down). */
  report: ReportEntry[];
}

function percent(scale: number): string {
  return `${Math.round(scale * 1000) / 10}%`;
}

/**
 * One page per slide with the slide's pictures (crop / flips are not applied: "Image only" slides
 * are a single unrotated full-slide picture). Page size in pt = frame size in px, scaled down
 * uniformly when a side exceeds CONFIG.pdf.maxPageSidePt. JPEG assets are embedded as they are
 * (DCTDecode, no re-encoding), so the quality is the one chosen for the image optimization step.
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
    const size = imagePageSize(slide.width, slide.height);
    const page = doc.addPage([size.width, size.height]);
    if (size.scale < 1) {
      report.push({
        level: 'info',
        code: 'pdf-page-scaled',
        slideId: slide.id,
        slideName: slide.name,
        message: `Page scaled to ${percent(size.scale)} to stay within the PDF page limit of ${CONFIG.pdf.maxPageSidePt} pt per side.`,
      });
    }
    if (slide.background) {
      const c = slide.background.color;
      page.drawRectangle({ x: 0, y: 0, width: size.width, height: size.height, color: rgb(c.r, c.g, c.b), opacity: c.a });
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
      drawImage(page, img, e, size.scale, size.height);
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
  return { data: await doc.save({ useObjectStreams: true }), report };
}
