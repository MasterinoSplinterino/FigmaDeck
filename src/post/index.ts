/**
 * OOXML post-processing of the pptxgenjs output (JSZip, string-level edits only — never a DOM
 * round-trip, so namespace prefixes and unknown markup survive).
 *
 *   per slide: text bodies, fills, lines, geometry, shadows, hyperlinks, SVG blips, groups, names
 *   package:   notes size, document properties, content types, media dedupe, "PptxGenJS" scrub
 */
import JSZip from 'jszip';
import { CONFIG } from '../config';
import type { BuildManifest } from '../build/manifest';
import { dedupeMedia, svgPartName } from './media';
import { patchAppXml, patchContentTypes, patchCoreXml, patchPresentationXml, scrubGeneratorName } from './package';
import { patchSlide } from './slide';

export interface PostWarning {
  /** 1-based slide number. */
  slideNumber: number;
  message: string;
}

export interface PostResult {
  data: Uint8Array;
  warnings: PostWarning[];
}

async function readText(zip: JSZip, path: string): Promise<string> {
  const f = zip.file(path);
  if (!f) throw new Error(`post: part ${path} not found`);
  return f.async('string');
}

async function patchPart(zip: JSZip, path: string, fn: (xml: string) => string): Promise<void> {
  const f = zip.file(path);
  if (!f) return;
  zip.file(path, fn(await f.async('string')));
}

const STORED_EXTENSIONS = /\.(png|jpe?g|gif)$/i;

export async function postProcess(
  pptx: Uint8Array,
  manifest: BuildManifest,
  onProgress?: (done: number, total: number) => void,
): Promise<PostResult> {
  const zip = await JSZip.loadAsync(pptx);
  const warnings: PostWarning[] = [];

  // SVG media parts (one per asset, shared by all slides that use it).
  const svgTargets = new Map<string, string>();
  Object.keys(manifest.svgAssets).forEach((assetId, i) => {
    const part = svgPartName(i);
    zip.file(part, manifest.svgAssets[assetId]);
    svgTargets.set(assetId, '../' + part.slice('ppt/'.length));
  });

  const total = manifest.slides.length;
  for (let i = 0; i < total; i++) {
    const sm = manifest.slides[i];
    const slidePath = `ppt/slides/slide${sm.number}.xml`;
    const relsPath = `ppt/slides/_rels/slide${sm.number}.xml.rels`;
    const result = patchSlide({
      xml: await readText(zip, slidePath),
      relsXml: await readText(zip, relsPath),
      manifest: sm,
      svgTargets,
    });
    zip.file(slidePath, result.xml);
    zip.file(relsPath, result.relsXml);
    for (const message of result.warnings) warnings.push({ slideNumber: sm.number, message });
    onProgress?.(i + 1, total);
  }

  await patchPart(zip, 'ppt/presentation.xml', patchPresentationXml);
  await patchPart(zip, 'docProps/core.xml', (xml) => patchCoreXml(xml, manifest.meta));
  await patchPart(zip, 'docProps/app.xml', (xml) => patchAppXml(xml, manifest.meta));

  if (CONFIG.pptx.dedupeMedia) await dedupeMedia(zip);

  const parts = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  await patchPart(zip, '[Content_Types].xml', (xml) => patchContentTypes(xml, parts));
  return { data: await repack(zip, parts, new Date(manifest.meta.timestamp)), warnings };
}

/** Package order: content types first, then the package relationships, then everything else as written. */
function partRank(name: string): number {
  if (name === '[Content_Types].xml') return 0;
  if (name === '_rels/.rels') return 1;
  return 2;
}

/**
 * Write the final ZIP: parts only (pptxgenjs also writes folder entries, which are not OPC parts),
 * `[Content_Types].xml` first, XML deflated, already-compressed media stored, a fixed entry date, and the
 * last-line "PptxGenJS" scrub of docProps (the only parts where pptxgenjs writes its name).
 */
async function repack(zip: JSZip, parts: ReadonlyArray<string>, date: Date): Promise<Uint8Array> {
  const out = new JSZip();
  const ordered = [...parts].sort((a, b) => partRank(a) - partRank(b));
  const validDate = Number.isFinite(date.getTime()) ? date : new Date();
  for (const name of ordered) {
    const file = zip.files[name];
    if (/\.(xml|rels)$/i.test(name)) {
      // pptxgenjs only writes its name into docProps; never rewrite user text / links elsewhere.
      const text = await file.async('string');
      out.file(name, name.startsWith('docProps/') ? scrubGeneratorName(text) : text, { createFolders: false, date: validDate, compression: 'DEFLATE' });
    } else {
      const compression = STORED_EXTENSIONS.test(name) ? 'STORE' : 'DEFLATE';
      out.file(name, await file.async('uint8array'), { createFolders: false, date: validDate, compression });
    }
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
