/**
 * Package-level OOXML fixes: document properties, notes size, content types, leftovers of pptxgenjs.
 * All edits are string-level.
 */
import { CONFIG } from '../config';
import type { PackageMeta } from '../build/manifest';
import { escapeXml } from '../build/xml';

/** Replace the text content of the first `<tag …>…</tag>` / `<tag/>`; insert before `</root>` when missing. */
export function setElementText(xml: string, tag: string, value: string, rootClose: string, attrs = ''): string {
  const escaped = escapeXml(value);
  const re = new RegExp(`<${tag}(\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`);
  if (re.test(xml)) {
    return xml.replace(re, (_m, a: string | undefined) => `<${tag}${a ?? attrs}>${escaped}</${tag}>`);
  }
  const at = xml.lastIndexOf(rootClose);
  if (at < 0) return xml;
  return xml.slice(0, at) + `<${tag}${attrs}>${escaped}</${tag}>` + xml.slice(at);
}

/** docProps/core.xml: title, subject, creator, lastModifiedBy, created, modified. */
export function patchCoreXml(xml: string, meta: PackageMeta): string {
  const close = '</cp:coreProperties>';
  const w3c = ' xsi:type="dcterms:W3CDTF"';
  let out = xml;
  out = setElementText(out, 'dc:title', meta.title, close);
  out = setElementText(out, 'dc:subject', meta.subject, close);
  out = setElementText(out, 'dc:creator', meta.author, close);
  out = setElementText(out, 'cp:lastModifiedBy', meta.author, close);
  out = setElementText(out, 'dcterms:created', meta.timestamp, close, w3c);
  out = setElementText(out, 'dcterms:modified', meta.timestamp, close, w3c);
  return out;
}

/** docProps/app.xml: Application, PresentationFormat, Company. */
export function patchAppXml(xml: string, meta: PackageMeta): string {
  const close = '</Properties>';
  let out = xml;
  out = setElementText(out, 'Application', meta.application, close);
  out = setElementText(out, 'PresentationFormat', 'Custom', close);
  out = setElementText(out, 'Company', meta.company, close);
  return out;
}

/** ppt/presentation.xml: a normal portrait notes page instead of the swapped slide size. */
export function patchPresentationXml(xml: string): string {
  const notesSz = `<p:notesSz cx="${CONFIG.pptx.notesWidthEmu}" cy="${CONFIG.pptx.notesHeightEmu}"/>`;
  // Do NOT reorder <p:notesMasterIdLst> / <p:sldIdLst> into XSD order: verified with PowerPoint 365
  // (Windows) that pptxgenjs packages with notesMasterIdLst moved before sldIdLst are refused with
  // "PowerPoint can't read <file>", while pptxgenjs's own order opens fine.
  return xml.replace(/<p:notesSz\b[^>]*\/>/, () => notesSz);
}

const DEFAULT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
};

/**
 * [Content_Types].xml:
 * - drop `<Override>`s of parts that do not exist (pptxgenjs lists a slideMaster per slide);
 * - `jpg` → `image/jpeg` (pptxgenjs writes the non-standard `image/jpg`);
 * - add `<Default>`s for extensions of existing parts that have none.
 */
export function patchContentTypes(xml: string, partNames: ReadonlyArray<string>): string {
  const parts = new Set(partNames.map((p) => '/' + p.replace(/^\//, '')));
  let out = xml.replace(/\s*<Override\b[^>]*\bPartName="([^"]+)"[^>]*\/>/g, (all, name: string) => (parts.has(name) ? all : ''));
  out = out.replace(/(<Default\b[^>]*\bExtension="jpg"[^>]*\bContentType=")[^"]*(")/, '$1image/jpeg$2');
  const defaults = new Set([...out.matchAll(/<Default\b[^>]*\bExtension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...out.matchAll(/<Override\b[^>]*\bPartName="([^"]+)"/g)].map((m) => m[1]));
  const missing = new Set<string>();
  for (const p of parts) {
    if (overrides.has(p)) continue;
    const ext = /\.([^./]+)$/.exec(p)?.[1]?.toLowerCase();
    if (ext && !defaults.has(ext) && DEFAULT_TYPES[ext]) missing.add(ext);
  }
  if (missing.size > 0) {
    const add = [...missing].map((e) => `<Default Extension="${e}" ContentType="${DEFAULT_TYPES[e]}"/>`).join('');
    out = out.replace(/(<Types\b[^>]*>)/, `$1${add}`);
  }
  return out;
}

/** Last line of defence: no "PptxGenJS" string anywhere in an XML part. */
export function scrubGeneratorName(xml: string): string {
  return xml.includes('PptxGenJS') ? xml.replace(/PptxGenJS/g, escapeXml(CONFIG.meta.application)) : xml;
}
