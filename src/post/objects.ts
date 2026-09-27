/**
 * Patches applied to one top-level object (`<p:sp>` / `<p:pic>`) of a slide, as string edits.
 * Every function takes the object's XML and returns the patched XML; they throw when the expected
 * anchor is missing (a pptxgenjs change must not silently produce a broken file).
 */
import { elementEnd } from './spTree';

export interface HyperlinkRef {
  rId: string;
  /** `ppaction://hlinksldjump` for slide jumps. */
  action?: string;
}

/** Range [start, end) of the first element `<tag …>` in `xml` at or after `from`, or null. */
function findElement(xml: string, tag: string, from = 0): { start: number; end: number } | null {
  const re = new RegExp(`<${tag}(?=[\\s/>])`, 'g');
  re.lastIndex = from;
  const m = re.exec(xml);
  if (!m) return null;
  return { start: m.index, end: elementEnd(xml, m.index) };
}

/** Apply `fn` to the object's `<p:spPr>…</p:spPr>` element (expanded if self-closing). */
function withSpPr(obj: string, fn: (spPr: string) => string): string {
  const r = findElement(obj, 'p:spPr');
  if (!r) throw new Error('post: <p:spPr> not found');
  let spPr = obj.slice(r.start, r.end);
  if (spPr.endsWith('/>')) spPr = spPr.slice(0, -2) + '></p:spPr>';
  return obj.slice(0, r.start) + fn(spPr) + obj.slice(r.end);
}

/** Replace the whole `<p:txBody>`. */
export function replaceTxBody(obj: string, txBody: string): string {
  const r = findElement(obj, 'p:txBody');
  if (r) return obj.slice(0, r.start) + txBody + obj.slice(r.end);
  // No body yet: it follows <p:spPr> (then <p:style> is not written by pptxgenjs).
  const sp = findElement(obj, 'p:spPr');
  if (!sp) throw new Error('post: <p:spPr> not found');
  return obj.slice(0, sp.end) + txBody + obj.slice(sp.end);
}

/** Replace `<a:prstGeom>` (or `<a:custGeom>`) inside `<p:spPr>`. */
export function replaceGeometry(obj: string, geometry: string): string {
  return withSpPr(obj, (spPr) => {
    const r = findElement(spPr, 'a:prstGeom') ?? findElement(spPr, 'a:custGeom');
    if (!r) throw new Error('post: geometry not found');
    return spPr.slice(0, r.start) + geometry + spPr.slice(r.end);
  });
}

const FILL_TAGS = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'];

/** Replace the shape fill (the fill element right after the geometry) or insert one there. */
export function replaceFill(obj: string, fill: string): string {
  return withSpPr(obj, (spPr) => {
    const geom = findElement(spPr, 'a:prstGeom') ?? findElement(spPr, 'a:custGeom');
    if (!geom) throw new Error('post: geometry not found');
    let pos = geom.end;
    while (/\s/.test(spPr[pos] ?? '')) pos++;
    for (const tag of FILL_TAGS) {
      if (new RegExp(`^<${tag}(?=[\\s/>])`).test(spPr.slice(pos, pos + tag.length + 2))) {
        const end = elementEnd(spPr, pos);
        return spPr.slice(0, pos) + fill + spPr.slice(end);
      }
    }
    return spPr.slice(0, geom.end) + fill + spPr.slice(geom.end);
  });
}

/** Replace `<a:ln>` inside `<p:spPr>`, or insert it after the fill when there is none. */
export function replaceLn(obj: string, ln: string): string {
  return withSpPr(obj, (spPr) => {
    const r = findElement(spPr, 'a:ln');
    if (r) return spPr.slice(0, r.start) + ln + spPr.slice(r.end);
    const before = /<a:(effectLst|effectDag|scene3d|sp3d|extLst)(?=[\s/>])|<\/p:spPr>/.exec(spPr);
    const at = before ? before.index : spPr.length;
    return spPr.slice(0, at) + ln + spPr.slice(at);
  });
}

/** Set `<a:effectLst>` (replacing any existing one) at its schema position in `<p:spPr>`. */
export function setEffectList(obj: string, effectLst: string): string {
  return withSpPr(obj, (spPr) => {
    const existing = findElement(spPr, 'a:effectLst');
    if (existing) return spPr.slice(0, existing.start) + effectLst + spPr.slice(existing.end);
    const before = /<a:(scene3d|sp3d|extLst)(?=[\s/>])|<\/p:spPr>/.exec(spPr);
    const at = before ? before.index : spPr.length;
    return spPr.slice(0, at) + effectLst + spPr.slice(at);
  });
}

/** Add a click hyperlink to the object's `<p:cNvPr>` (hlinkClick is its first child). */
export function addClickHyperlink(obj: string, link: HyperlinkRef): string {
  const m = /<p:cNvPr\b[^>]*?(\/?)>/.exec(obj);
  if (!m) throw new Error('post: <p:cNvPr> not found');
  const action = link.action ? ` action="${link.action}"` : '';
  const hlink = `<a:hlinkClick r:id="${link.rId}"${action}/>`;
  const start = m.index;
  const tagEnd = start + m[0].length;
  if (m[1] === '/') {
    const open = m[0].slice(0, -2).replace(/\s+$/, '') + '>';
    return obj.slice(0, start) + open + hlink + '</p:cNvPr>' + obj.slice(tagEnd);
  }
  // Drop an existing click action (pptxgenjs writes none for our objects, but be safe).
  let rest = obj.slice(tagEnd);
  const existing = /^\s*<a:hlinkClick\b/.test(rest) ? elementEnd(rest, rest.indexOf('<a:hlinkClick')) : -1;
  if (existing >= 0) rest = rest.slice(existing);
  return obj.slice(0, tagEnd) + hlink + rest;
}

/**
 * Add the SVG version of a picture: `<a:extLst><a:ext uri="{96DAC541-…}"><asvg:svgBlip r:embed/></a:ext></a:extLst>`
 * as the last child of `<a:blip>` (PowerPoint 2016+ renders the SVG, others the raster fallback).
 */
export function addSvgBlip(obj: string, rId: string): string {
  const ext =
    '<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">' +
    `<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${rId}"/>` +
    '</a:ext>';
  const r = findElement(obj, 'a:blip');
  if (!r) throw new Error('post: <a:blip> not found');
  let blip = obj.slice(r.start, r.end);
  if (blip.endsWith('/>')) blip = blip.slice(0, -2).replace(/\s+$/, '') + '></a:blip>';
  const extLst = findElement(blip, 'a:extLst');
  if (extLst) {
    const close = blip.lastIndexOf('</a:extLst>', extLst.end);
    blip = blip.slice(0, close) + ext + blip.slice(close);
  } else {
    const close = blip.lastIndexOf('</a:blip>');
    blip = blip.slice(0, close) + `<a:extLst>${ext}</a:extLst>` + blip.slice(close);
  }
  return obj.slice(0, r.start) + blip + obj.slice(r.end);
}
