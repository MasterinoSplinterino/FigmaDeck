/**
 * PPTX package inspection + validation for tests.
 *
 *   const pkg = await openPptx(bytes);
 *   expect(validatePackage(pkg)).toEqual([]);
 *   const slide = pkg.text('ppt/slides/slide1.xml');
 *
 * The validator checks what makes PowerPoint show its "repair" dialog or refuse a file: malformed XML,
 * dangling relationships, parts without a content type, duplicate drawing ids, slide size outside
 * 1″…56″, schema-order mistakes we are prone to (`<a:pPr>` position), leftovers of pptxgenjs.
 */
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';

export interface PptxPackage {
  zip: JSZip;
  /** Part names (no leading slash), files only. */
  parts: string[];
  /** Text of an XML / rels part. Throws if missing. */
  text(path: string): string;
  bytes(path: string): Uint8Array;
  has(path: string): boolean;
}

const TEXT_PART = /\.(xml|rels|svg)$/i;

export async function openPptx(data: Uint8Array): Promise<PptxPackage> {
  const zip = await JSZip.loadAsync(data);
  const parts = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const texts = new Map<string, string>();
  const bins = new Map<string, Uint8Array>();
  for (const p of parts) {
    if (TEXT_PART.test(p)) texts.set(p, await zip.files[p].async('string'));
    bins.set(p, await zip.files[p].async('uint8array'));
  }
  return {
    zip,
    parts,
    text(path) {
      const t = texts.get(path);
      if (t === undefined) throw new Error(`part ${path} not found`);
      return t;
    },
    bytes(path) {
      const b = bins.get(path);
      if (b === undefined) throw new Error(`part ${path} not found`);
      return b;
    },
    has(path) {
      return bins.has(path);
    },
  };
}

// ─── Small XML helpers (regex based, good enough for generated OOXML) ────────

/** All start tags `<tag …>` / `<tag …/>` (exact tag name). */
export function tags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag.replace(':', '\\:')}(?=[\\s/>])[^>]*>`, 'g');
  return xml.match(re) ?? [];
}

export function countTags(xml: string, tag: string): number {
  return tags(xml, tag).length;
}

/** Attributes of a start tag. */
export function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Attribute maps of all `<tag>` start tags. */
export function tagAttrs(xml: string, tag: string): Array<Record<string, string>> {
  return tags(xml, tag).map(attrsOf);
}

/** Full elements `<tag …>…</tag>` (non-nested tags only: a:p, a:r, p:sp, p:pic…). */
export function elements(xml: string, tag: string): string[] {
  const t = tag.replace(':', '\\:');
  const re = new RegExp(`<${t}(?=[\\s/>])(?:[^>]*/>|[^>]*>[\\s\\S]*?</${t}>)`, 'g');
  return xml.match(re) ?? [];
}

/** The `<p:sp>` / `<p:pic>` whose cNvPr name is `name` (escaped form). */
export function objectByName(slideXml: string, name: string): string {
  for (const tag of ['p:sp', 'p:pic']) {
    for (const el of elements(slideXml, tag)) {
      if (new RegExp(`<p:cNvPr\\b[^>]*\\bname="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(el)) return el;
    }
  }
  throw new Error(`object "${name}" not found`);
}

/** Names of the `<p:cNvPr>` of all drawing objects in a slide. */
export function objectNames(slideXml: string): string[] {
  return tagAttrs(slideXml, 'p:cNvPr').map((a) => a.name);
}

export function slideCount(pkg: PptxPackage): number {
  return pkg.parts.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).length;
}

export function slideXml(pkg: PptxPackage, n: number): string {
  return pkg.text(`ppt/slides/slide${n}.xml`);
}

export function slideSize(pkg: PptxPackage): { cx: number; cy: number } {
  const a = tagAttrs(pkg.text('ppt/presentation.xml'), 'p:sldSz')[0];
  return { cx: Number(a.cx), cy: Number(a.cy) };
}

// ─── Relationships ───────────────────────────────────────────────────────────

export interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function decode(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function relsPathOf(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

export function relationships(pkg: PptxPackage, part: string): Rel[] {
  const path = relsPathOf(part);
  if (!pkg.has(path)) return [];
  return tagAttrs(pkg.text(path), 'Relationship').map((a) => ({
    id: a.Id,
    type: decode(a.Type ?? ''),
    target: decode(a.Target ?? ''),
    external: a.TargetMode === 'External',
  }));
}

/** Resolve a relationship target relative to its source part. */
export function resolveTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = sourcePart.slice(0, sourcePart.lastIndexOf('/') + 1);
  const segs: string[] = [];
  for (const s of (base + target).split('/')) {
    if (s === '..') segs.pop();
    else if (s !== '.' && s !== '') segs.push(s);
  }
  return segs.join('/');
}

// ─── Validation ──────────────────────────────────────────────────────────────

const MIN_SLIDE = 914400;
/** Characters not allowed in XML 1.0 (C0 controls except TAB/LF/CR, U+FFFE/U+FFFF, lone surrogates). */
const INVALID_XML_CHAR = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
);
const MAX_SLIDE = 51206400;

function sourceOfRels(relsPath: string): string {
  // a/b/_rels/c.xml.rels → a/b/c.xml ; _rels/.rels → '' (package root)
  const m = /^(.*?)_rels\/(.*)\.rels$/.exec(relsPath);
  return m ? m[1] + m[2] : relsPath;
}

/** Returns a list of problems (empty = valid). */
export function validatePackage(pkg: PptxPackage): string[] {
  const problems: string[] = [];
  const has = (p: string) => pkg.parts.includes(p);

  // 1. Well-formed XML (fast-xml-parser does not check characters: do it here)
  for (const p of pkg.parts) {
    if (!/\.(xml|rels)$/i.test(p)) continue;
    const xml = pkg.text(p);
    const res = XMLValidator.validate(xml);
    if (res !== true) problems.push(`${p}: not well-formed: ${res.err.msg} (line ${res.err.line})`);
    const bad = INVALID_XML_CHAR.exec(xml);
    if (bad) problems.push(`${p}: invalid XML character U+${bad[0].charCodeAt(0).toString(16).padStart(4, '0')} at ${bad.index}`);
  }

  // 2. Content types
  if (!has('[Content_Types].xml')) {
    problems.push('[Content_Types].xml missing');
  } else {
    const ct = pkg.text('[Content_Types].xml');
    const defaults = new Set(tagAttrs(ct, 'Default').map((a) => a.Extension.toLowerCase()));
    const overrides = tagAttrs(ct, 'Override').map((a) => a.PartName);
    for (const o of overrides) if (!has(o.replace(/^\//, ''))) problems.push(`content type override for missing part ${o}`);
    const overrideSet = new Set(overrides);
    for (const p of pkg.parts) {
      if (p === '[Content_Types].xml') continue;
      const ext = /\.([^./]+)$/.exec(p)?.[1]?.toLowerCase() ?? '';
      if (!overrideSet.has('/' + p) && !defaults.has(ext)) problems.push(`part ${p} has no content type`);
    }
  }

  // 3. Relationships: targets exist, ids unique, referenced ids exist
  for (const relsPath of pkg.parts.filter((p) => p.endsWith('.rels'))) {
    const source = sourceOfRels(relsPath);
    if (source && !has(source)) problems.push(`${relsPath}: source part ${source} missing`);
    const rels = tagAttrs(pkg.text(relsPath), 'Relationship');
    const ids = new Set<string>();
    for (const r of rels) {
      if (ids.has(r.Id)) problems.push(`${relsPath}: duplicate id ${r.Id}`);
      ids.add(r.Id);
      if (r.TargetMode === 'External') continue;
      const target = resolveTarget(source || '/', decode(r.Target));
      if (!has(target)) problems.push(`${relsPath}: ${r.Id} → missing part ${target}`);
    }
    if (source && /\.xml$/.test(source) && has(source)) {
      const xml = pkg.text(source);
      for (const m of xml.matchAll(/\br:(?:id|embed|link|pict)="([^"]*)"/g)) {
        if (m[1] && !ids.has(m[1])) problems.push(`${source}: reference to unknown relationship ${m[1]}`);
      }
    }
  }

  // 4. Slides
  const slides = pkg.parts.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  for (const p of slides) {
    const xml = pkg.text(p);
    const ids = tagAttrs(xml, 'p:cNvPr').map((a) => a.id);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${p}: duplicate cNvPr id ${id}`);
      seen.add(id);
    }
    for (const para of elements(xml, 'a:p')) {
      const pPrCount = countTags(para, 'a:pPr');
      if (pPrCount > 1) problems.push(`${p}: <a:p> with ${pPrCount} <a:pPr>`);
      if (pPrCount === 1 && !/^<a:p>\s*<a:pPr\b/.test(para)) problems.push(`${p}: <a:pPr> is not the first child of <a:p>`);
    }
    if (/<a:ln(\s[^>]*)?><\/a:ln>/.test(xml)) problems.push(`${p}: empty <a:ln></a:ln>`);
    if (/\bname="fd:\d+"/.test(xml)) problems.push(`${p}: internal fd:<n> object names left`);
  }

  // 5. Slide size
  if (has('ppt/presentation.xml')) {
    const { cx, cy } = slideSize(pkg);
    for (const [k, v] of [['cx', cx], ['cy', cy]] as const) {
      if (!(v >= MIN_SLIDE && v <= MAX_SLIDE)) problems.push(`sldSz ${k}=${v} outside ${MIN_SLIDE}…${MAX_SLIDE}`);
    }
  }

  // 6. No generator leftovers
  for (const p of pkg.parts) {
    if (TEXT_PART.test(p) && pkg.text(p).includes('PptxGenJS')) problems.push(`${p}: contains "PptxGenJS"`);
  }
  return problems;
}
