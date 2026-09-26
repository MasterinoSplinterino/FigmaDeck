#!/usr/bin/env node
// Repairs a PPTX whose slide is larger than PowerPoint's 56-inch limit (or smaller than 1 inch),
// e.g. files exported 1 px = 1 pt from very wide Figma frames. PowerPoint refuses such files.
//
// Usage: node scripts/fix-oversized-pptx.mjs input.pptx [output.pptx]
//
// Scales <p:sldSz> into the valid range and scales every slide uniformly: positions, sizes,
// font sizes, letter / line / paragraph spacing, insets, indents, line widths, shadows.
// XML is edited as text (attributes only), so namespaces and unknown markup stay untouched.
import JSZip from 'jszip';
import { readFile, writeFile } from 'node:fs/promises';

const MAX = 51206400; // 56 in
const MIN = 914400; // 1 in

const [input, outputArg] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node scripts/fix-oversized-pptx.mjs input.pptx [output.pptx]');
  process.exit(1);
}
const output = outputArg ?? input.replace(/\.pptx$/i, '') + '_fixed.pptx';

const zip = await JSZip.loadAsync(await readFile(input));
const presPath = 'ppt/presentation.xml';
let pres = await zip.file(presPath).async('string');
const m = /<p:sldSz\b[^>]*?\bcx="(\d+)"[^>]*?\bcy="(\d+)"/.exec(pres);
if (!m) throw new Error('No <p:sldSz> found');
const cx = Number(m[1]);
const cy = Number(m[2]);
let s = 1;
if (Math.max(cx, cy) > MAX) s = MAX / Math.max(cx, cy);
if (Math.min(cx, cy) * s < MIN) s = MIN / Math.min(cx, cy);
if (s === 1) {
  console.log(`Slide size ${cx}×${cy} EMU is already valid; nothing to do.`);
  process.exit(0);
}
const ncx = Math.min(MAX, Math.max(MIN, Math.round(cx * s)));
const ncy = Math.min(MAX, Math.max(MIN, Math.round(cy * s)));
pres = pres.replace(/<p:sldSz\b[^>]*\/>/, (tag) => tag.replace(/\bcx="\d+"/, `cx="${ncx}"`).replace(/\bcy="\d+"/, `cy="${ncy}"`));
// Normal portrait notes page (some writers put the swapped slide size here).
pres = pres.replace(/<p:notesSz\b[^>]*\/>/, '<p:notesSz cx="6858000" cy="9144000"/>');
zip.file(presPath, pres);

const scaleInt = (v, min = -Infinity) => String(Math.max(min, Math.round(Number(v) * s)));
function scaleAttrs(tag, names, min) {
  return tag.replace(new RegExp(`\\b(${names.join('|')})="(-?\\d+)"`, 'g'), (_, n, v) => `${n}="${scaleInt(v, min)}"`);
}

function scaleSlideXml(xml) {
  return xml
    // geometry
    .replace(/<a:(off|chOff)\b[^>]*>/g, (t) => scaleAttrs(t, ['x', 'y']))
    .replace(/<a:(ext|chExt)\b[^>]*\bcx="[^>]*>/g, (t) => scaleAttrs(t, ['cx', 'cy'], 0))
    // text run properties: size (min 1 pt), letter spacing
    .replace(/<a:(rPr|endParaRPr|defRPr)\b[^>]*>/g, (t) => scaleAttrs(scaleAttrs(t, ['sz'], 100), ['spc']))
    // absolute line / paragraph spacing
    .replace(/<a:spcPts\b[^>]*>/g, (t) => scaleAttrs(t, ['val'], 0))
    // paragraph indents / margins, body insets
    .replace(/<a:(pPr|lvl\dpPr)\b[^>]*>/g, (t) => scaleAttrs(t, ['marL', 'marR', 'indent']))
    .replace(/<a:bodyPr\b[^>]*>/g, (t) => scaleAttrs(t, ['lIns', 'tIns', 'rIns', 'bIns'], 0))
    // lines and effects
    .replace(/<a:ln\b[^>]*>/g, (t) => scaleAttrs(t, ['w'], 0))
    .replace(/<a:(outerShdw|innerShdw|prstShdw|glow|softEdge)\b[^>]*>/g, (t) => scaleAttrs(t, ['dist', 'blurRad', 'rad'], 0));
}

const slideParts = Object.keys(zip.files).filter((p) => /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(p));
for (const p of slideParts) zip.file(p, scaleSlideXml(await zip.file(p).async('string')));

const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
await writeFile(output, out);
console.log(`Slide ${cx}×${cy} EMU (${(cx / 914400).toFixed(2)}″×${(cy / 914400).toFixed(2)}″) → ${ncx}×${ncy} EMU (${(ncx / 914400).toFixed(2)}″×${(ncy / 914400).toFixed(2)}″), scale ${s.toFixed(4)}; ${slideParts.length} parts rescaled.`);
console.log(`Written: ${output}`);
