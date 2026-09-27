/**
 * embedFontsIntoPptx: package structure after embedding (src/fonts/embed.ts, EXPERIMENTAL stage 4).
 * Checks well-formed XML, relationships, content types, `<p:presentation>` child order and the
 * `<p:embeddedFont>` entries — everything that decides whether PowerPoint shows its "repair" dialog.
 */
import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import {
  FNTDATA_CONTENT_TYPE,
  FONT_REL_TYPE,
  FontEmbedError,
  addEmbeddedFontsToPresentationXml,
  embedFontsIntoPptx,
  extractFontFromFntdata,
  findPresentationPart,
  nextRelationshipId,
  parseFontInfo,
  planFontEmbedding,
  readEotHeader,
  registerFntdataContentType,
  scanRoot,
  type EmbedFontInput,
  type EmbedWarning,
} from '../../src/fonts/embed';
import { loadFixture, testOptions } from '../fixtures/load';
import { attrsOf, openPptx, relationships, resolveTarget, tagAttrs, validatePackage, type PptxPackage } from '../helpers/ooxml';
import { LIBERATION_SANS, buildSfnt, hasLiberationSans, patchFsType, readFont } from './font-files';
import { makeTextPptx } from './pptx';

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof FontEmbedError) return e.code;
    throw e;
  }
  return undefined;
}

/** Local names of the direct children of <p:presentation>, in order. */
function presentationChildren(xml: string): string[] {
  return scanRoot(xml).children.map((c) => c.qname);
}

function fontParts(pkg: PptxPackage): string[] {
  return pkg.parts.filter((p) => p.endsWith('.fntdata')).sort();
}

const synthetic = (family: string, style: { bold?: boolean; italic?: boolean } = {}, fsType = 0) =>
  buildSfnt({
    names: { 1: family, 2: style.bold ? (style.italic ? 'Bold Italic' : 'Bold') : style.italic ? 'Italic' : 'Regular', 4: family },
    fsSelection: (style.bold ? 0x20 : 0) | (style.italic ? 0x01 : 0) || 0x40,
    weightClass: style.bold ? 700 : 400,
    fsType,
  });

describe('embedFontsIntoPptx on a pptxgenjs package', () => {
  it('adds parts, relationships, content type, attribute and list without disturbing anything else', async () => {
    const pptx = await makeTextPptx([{ text: 'Probe', face: 'Probe Sans' }]);
    const before = await openPptx(pptx);
    const out = await embedFontsIntoPptx(pptx, [
      { face: 'Probe Sans', bold: false, italic: false, bytes: synthetic('Probe Sans') },
      { face: 'Probe Sans', bold: true, italic: false, bytes: synthetic('Probe Sans', { bold: true }) },
    ]);
    const pkg = await openPptx(out);

    // No new validation problems (the raw pptxgenjs package has its own "PptxGenJS" leftovers).
    expect(validatePackage(pkg)).toEqual(validatePackage(before));
    for (const p of pkg.parts.filter((x) => /\.(xml|rels)$/.test(x))) expect(XMLValidator.validate(pkg.text(p))).toBe(true);

    // Parts
    expect(fontParts(pkg)).toEqual(['ppt/fonts/font1.fntdata', 'ppt/fonts/font2.fntdata']);
    expect(readEotHeader(pkg.bytes('ppt/fonts/font1.fntdata')).styleName).toBe('Regular');
    expect(readEotHeader(pkg.bytes('ppt/fonts/font2.fntdata')).styleName).toBe('Bold');

    // Content types
    const ct = pkg.text('[Content_Types].xml');
    expect(tagAttrs(ct, 'Default').filter((d) => d.Extension === 'fntdata')).toEqual([{ Extension: 'fntdata', ContentType: FNTDATA_CONTENT_TYPE }]);

    // Relationships: unique ids, old ones untouched, targets resolve to the font parts
    const relsBefore = relationships(before, 'ppt/presentation.xml');
    const rels = relationships(pkg, 'ppt/presentation.xml');
    expect(rels.slice(0, relsBefore.length)).toEqual(relsBefore);
    const fontRels = rels.filter((r) => r.type === FONT_REL_TYPE);
    expect(fontRels.map((r) => resolveTarget('ppt/presentation.xml', r.target)).sort()).toEqual(fontParts(pkg));
    expect(new Set(rels.map((r) => r.id)).size).toBe(rels.length);

    // presentation.xml: attribute, list position, entry structure
    const xml = pkg.text('ppt/presentation.xml');
    const root = attrsOf(/<p:presentation\b[^>]*>/.exec(xml)![0]);
    expect(root.embedTrueTypeFonts).toBe('1');
    expect(root.saveSubsetFonts).toBe('1'); // pptxgenjs' own attribute is left alone
    const childrenBefore = presentationChildren(before.text('ppt/presentation.xml'));
    const children = presentationChildren(xml);
    expect(children.filter((c) => c !== 'p:embeddedFontLst')).toEqual(childrenBefore); // nothing moved
    expect(children.indexOf('p:embeddedFontLst')).toBe(children.indexOf('p:notesSz') + 1);
    expect(children.indexOf('p:embeddedFontLst')).toBeLessThan(children.indexOf('p:defaultTextStyle'));

    const list = /<p:embeddedFontLst>([\s\S]*?)<\/p:embeddedFontLst>/.exec(xml)![1];
    const byId = new Map(fontRels.map((r) => [r.id, resolveTarget('ppt/presentation.xml', r.target)]));
    expect(list).toMatch(/^<p:embeddedFont><p:font typeface="Probe Sans" panose="020B0604020202020204" pitchFamily="34" charset="0"\/><p:regular r:id="rId\d+"\/><p:bold r:id="rId\d+"\/><\/p:embeddedFont>$/);
    const regularId = /<p:regular r:id="([^"]+)"/.exec(list)![1];
    const boldId = /<p:bold r:id="([^"]+)"/.exec(list)![1];
    expect(byId.get(regularId)).toBe('ppt/fonts/font1.fntdata');
    expect(byId.get(boldId)).toBe('ppt/fonts/font2.fntdata');
    expect(new Set([regularId, boldId, ...relsBefore.map((r) => r.id)]).size).toBe(relsBefore.length + 2);

    // Slides untouched
    expect(pkg.text('ppt/slides/slide1.xml')).toBe(before.text('ppt/slides/slide1.xml'));
  });

  it('writes the four RIBBI slots in schema order regardless of input order, one part per distinct file', async () => {
    const pptx = await makeTextPptx([{ text: 'Probe', face: 'Probe Sans' }]);
    const regular = synthetic('Probe Sans');
    const inputs: EmbedFontInput[] = [
      { face: 'Probe Sans', bold: true, italic: true, bytes: synthetic('Probe Sans', { bold: true, italic: true }) },
      { face: 'Probe Sans', bold: false, italic: true, bytes: synthetic('Probe Sans', { italic: true }) },
      { face: 'Probe Sans', bold: false, italic: false, bytes: regular },
      { face: 'Probe Sans', bold: true, italic: false, bytes: synthetic('Probe Sans', { bold: true }) },
    ];
    const pkg = await openPptx(await embedFontsIntoPptx(pptx, inputs));
    const entry = /<p:embeddedFont>[\s\S]*?<\/p:embeddedFont>/.exec(pkg.text('ppt/presentation.xml'))![0];
    expect([...entry.matchAll(/<p:(font|regular|bold|italic|boldItalic)\b/g)].map((m) => m[1])).toEqual(['font', 'regular', 'bold', 'italic', 'boldItalic']);
    expect(fontParts(pkg)).toHaveLength(4);
  });

  it('stores byte-identical files once and groups faces case-insensitively', async () => {
    const pptx = await makeTextPptx([{ text: 'A', face: 'Probe Sans' }]);
    const bytes = synthetic('Probe Sans');
    const warnings: EmbedWarning[] = [];
    const out = await embedFontsIntoPptx(
      pptx,
      [
        { face: 'Probe Sans', bold: false, italic: false, bytes },
        { face: 'probe sans', bold: true, italic: false, bytes: bytes.slice() },
      ],
      { onWarning: (w) => warnings.push(w) },
    );
    const pkg = await openPptx(out);
    expect(fontParts(pkg)).toEqual(['ppt/fonts/font1.fntdata']);
    const xml = pkg.text('ppt/presentation.xml');
    expect((xml.match(/<p:embeddedFont>/g) ?? []).length).toBe(1);
    const ids = [...xml.matchAll(/<p:(?:regular|bold) r:id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(warnings.map((w) => w.code)).toEqual(['style-mismatch']); // a Regular file used as the bold member
  });

  it('a second call appends to the existing list and never duplicates the fntdata default', async () => {
    const pptx = await makeTextPptx([{ text: 'A', face: 'One' }]);
    const once = await embedFontsIntoPptx(pptx, [{ face: 'One', bold: false, italic: false, bytes: synthetic('One') }]);
    const twice = await embedFontsIntoPptx(once, [{ face: 'Two', bold: false, italic: false, bytes: synthetic('Two') }]);
    const pkg = await openPptx(twice);
    const xml = pkg.text('ppt/presentation.xml');
    expect((xml.match(/<p:embeddedFontLst>/g) ?? []).length).toBe(1);
    expect([...xml.matchAll(/<p:font typeface="([^"]+)"/g)].map((m) => m[1])).toEqual(['One', 'Two']);
    expect(fontParts(pkg)).toEqual(['ppt/fonts/font1.fntdata', 'ppt/fonts/font2.fntdata']);
    expect((pkg.text('[Content_Types].xml').match(/Extension="fntdata"/g) ?? []).length).toBe(1);
    expect(await codeOf(embedFontsIntoPptx(twice, [{ face: 'ONE', bold: true, italic: false, bytes: synthetic('ONE', { bold: true }) }]))).toBe('already-embedded');
  });

  it('refuses restricted and bitmap-only fonts, and other invalid input, with codes', async () => {
    const pptx = await makeTextPptx([{ text: 'A', face: 'X' }]);
    const input = (bytes: Uint8Array, face = 'X'): EmbedFontInput[] => [{ face, bold: false, italic: false, bytes }];
    expect(await codeOf(embedFontsIntoPptx(pptx, input(synthetic('X', {}, 0x0002))))).toBe('restricted');
    expect(await codeOf(embedFontsIntoPptx(pptx, input(synthetic('X', {}, 0x0200))))).toBe('bitmap-only');
    expect(await codeOf(embedFontsIntoPptx(pptx, input(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]))))).toBe('unsupported-format');
    expect(await codeOf(embedFontsIntoPptx(pptx, input(synthetic('X'), '  ')))).toBe('empty-face');
    expect(await codeOf(embedFontsIntoPptx(pptx, [...input(synthetic('X')), ...input(synthetic('X'))]))).toBe('duplicate-slot');
    expect(await codeOf(embedFontsIntoPptx(new Uint8Array([1, 2, 3]), input(synthetic('X'))))).toBe('invalid-package');
    await expect(embedFontsIntoPptx(pptx, input(synthetic('X', {}, 0x0002)))).rejects.toThrow(/Restricted License/);
  });

  it('preview & print fonts: warning by default, error when not allowed; CFF likewise', async () => {
    const pptx = await makeTextPptx([{ text: 'A', face: 'X' }]);
    const pp: EmbedFontInput[] = [{ face: 'X', bold: false, italic: false, bytes: synthetic('X', {}, 0x0004) }];
    const warnings: EmbedWarning[] = [];
    await embedFontsIntoPptx(pptx, pp, { onWarning: (w) => warnings.push(w) });
    expect(warnings.map((w) => w.code)).toEqual(['preview-print']);
    expect(await codeOf(embedFontsIntoPptx(pptx, pp, { allowPreviewPrint: false }))).toBe('preview-print');

    const cff: EmbedFontInput[] = [{ face: 'X', bold: false, italic: false, bytes: buildSfnt({ flavor: 'otf', names: { 1: 'X' } }) }];
    expect(planFontEmbedding(cff).warnings.map((w) => w.code)).toEqual(['cff-outlines']);
    expect(await codeOf(() => planFontEmbedding(cff, { allowCff: false }))).toBe('cff-not-allowed');
  });

  it('warns when the face differs from the font family (PowerPoint matches embedded fonts by their own name)', () => {
    const plan = planFontEmbedding([{ face: 'SB Sans Display Semibold', bold: false, italic: false, bytes: synthetic('SB Sans Display') }]);
    expect(plan.warnings).toEqual([expect.objectContaining({ code: 'face-mismatch', face: 'SB Sans Display Semibold', slot: 'regular' })]);
    expect(planFontEmbedding([{ face: ' sb  sans display ', bold: false, italic: false, bytes: synthetic('SB Sans Display') }]).warnings).toEqual([]);
  });

  it('returns the input unchanged when there is nothing to embed', async () => {
    const pptx = await makeTextPptx([{ text: 'A', face: 'X' }]);
    expect(await embedFontsIntoPptx(pptx, [])).toBe(pptx);
  });
});

describe('embedFontsIntoPptx on a FigmaDeck build (src/build)', () => {
  it('keeps the post-processed package valid', async () => {
    const built = await buildPptx(loadFixture('diploma'), testOptions());
    const faces = [...new Map(built.fonts.map((f) => [`${f.face}|${f.bold}|${f.italic}`, f])).values()];
    expect(faces.length).toBeGreaterThan(0);
    const out = await embedFontsIntoPptx(
      built.data,
      faces.map((f) => ({ face: f.face, bold: f.bold, italic: f.italic, bytes: synthetic(f.face, { bold: f.bold, italic: f.italic }) })),
    );
    const pkg = await openPptx(out);
    expect(validatePackage(pkg)).toEqual([]);
    expect(fontParts(pkg)).toHaveLength(faces.length);
    const listed = [...pkg.text('ppt/presentation.xml').matchAll(/<p:font typeface="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set(faces.map((f) => f.face)));
  });
});

describe.skipIf(!hasLiberationSans())('embedFontsIntoPptx with real fonts', () => {
  it('embeds the four Liberation Sans members; the parts carry the original font bytes', async () => {
    const pptx = await makeTextPptx([
      { text: 'Regular', face: 'Liberation Sans' },
      { text: 'Bold Italic', face: 'Liberation Sans', bold: true, italic: true },
    ]);
    const files = Object.entries(LIBERATION_SANS).map(([slot, path]) => ({ slot, bytes: readFont(path) }));
    const out = await embedFontsIntoPptx(
      pptx,
      files.map(({ slot, bytes }) => ({ face: 'Liberation Sans', bold: slot.startsWith('bold'), italic: /italic/i.test(slot), bytes })),
    );
    const pkg = await openPptx(out);
    const parts = fontParts(pkg);
    expect(parts).toHaveLength(4);
    const extracted = parts.map((p) => parseFontInfo(extractFontFromFntdata(pkg.bytes(p))).subfamily).sort();
    expect(extracted).toEqual(['Bold', 'Bold Italic', 'Italic', 'Regular']);
    expect(extractFontFromFntdata(pkg.bytes(parts[0]))).toEqual(files[0].bytes);
  });

  it('refuses a restricted copy of a real font', async () => {
    const pptx = await makeTextPptx([{ text: 'A', face: 'Liberation Sans' }]);
    const bytes = patchFsType(readFont(LIBERATION_SANS.regular), 0x0002);
    expect(await codeOf(embedFontsIntoPptx(pptx, [{ face: 'Liberation Sans', bold: false, italic: false, bytes }]))).toBe('restricted');
  });
});

describe('string-level XML helpers', () => {
  const entry = (face: string) => ({ face, info: parseFontInfo(synthetic(face)), ids: { regular: 'rId9' } });
  const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  it('handles a default PML namespace, a missing r: declaration, comments and ">" in attribute values', () => {
    const xml =
      `<?xml version="1.0"?><!-- <presentation> in a comment -->` +
      `<presentation xmlns="${PML}" data-x="a>b"><sldIdLst><sldId id="256"/></sldIdLst><sldSz cx="1" cy="1"/>` +
      `<notesSz cx="1" cy="1"/><defaultTextStyle/></presentation>`;
    const out = addEmbeddedFontsToPresentationXml(xml, [entry('F')]);
    expect(XMLValidator.validate(out)).toBe(true);
    expect(out).toContain(`xmlns:r="${REL}"`);
    expect(out).toContain('embedTrueTypeFonts="1"');
    expect(out).toContain('data-x="a>b"');
    expect(scanRoot(out).children.map((c) => c.qname)).toEqual(['sldIdLst', 'sldSz', 'notesSz', 'embeddedFontLst', 'defaultTextStyle']);
    expect(out).toContain('<embeddedFont><font typeface="F"');
    expect(out).toContain('<regular r:id="rId9"/>');
  });

  it('uses the existing relationships prefix and replaces an existing embedTrueTypeFonts value', () => {
    const xml = `<p:presentation xmlns:p="${PML}" xmlns:rel="${REL}" embedTrueTypeFonts='0'><p:sldSz cx="1" cy="1"/><p:notesSz cx="1" cy="1"/></p:presentation>`;
    const out = addEmbeddedFontsToPresentationXml(xml, [entry('F')]);
    expect(out).toContain('<p:regular rel:id="rId9"/>');
    expect(out).toContain('embedTrueTypeFonts="1"');
    expect(out).not.toContain("embedTrueTypeFonts='0'");
    expect(out).not.toContain('xmlns:r=');
  });

  it('inserts before the first later sibling when no earlier one exists, else at the end', () => {
    const later = `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:custShowLst/><p:extLst/></p:presentation>`;
    expect(scanRoot(addEmbeddedFontsToPresentationXml(later, [entry('F')])).children.map((c) => c.qname)).toEqual(['p:embeddedFontLst', 'p:custShowLst', 'p:extLst']);
    const empty = `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"></p:presentation>`;
    expect(scanRoot(addEmbeddedFontsToPresentationXml(empty, [entry('F')])).children.map((c) => c.qname)).toEqual(['p:embeddedFontLst']);
  });

  it('ignores nested elements with the same local names (p:extLst inside p:sldId)', () => {
    const xml =
      `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId2"><p:extLst/></p:sldId></p:sldIdLst>` +
      `<p:sldSz cx="1" cy="1"/><p:notesSz cx="1" cy="1"/><p:extLst/></p:presentation>`;
    const out = addEmbeddedFontsToPresentationXml(xml, [entry('F')]);
    expect(scanRoot(out).children.map((c) => c.qname)).toEqual(['p:sldIdLst', 'p:sldSz', 'p:notesSz', 'p:embeddedFontLst', 'p:extLst']);
  });

  it('fills a self-closing existing list', () => {
    const xml = `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:notesSz cx="1" cy="1"/><p:embeddedFontLst/></p:presentation>`;
    const out = addEmbeddedFontsToPresentationXml(xml, [entry('F')]);
    expect(out).toMatch(/<p:embeddedFontLst><p:embeddedFont>.*<\/p:embeddedFont><\/p:embeddedFontLst><\/p:presentation>$/);
  });

  it('rejects non-presentation XML', () => {
    expect(() => addEmbeddedFontsToPresentationXml('<a xmlns="urn:x"/>', [entry('F')])).toThrow(FontEmbedError);
    expect(() => addEmbeddedFontsToPresentationXml(`<p:presentation xmlns:p="${PML}">`, [entry('F')])).toThrow(/not well-formed/);
  });

  it('content types: one Default, or Overrides when fntdata is registered with another type', () => {
    const ct = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
    const once = registerFntdataContentType(ct, ['ppt/fonts/font1.fntdata']);
    expect(once).toContain(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="fntdata" ContentType="${FNTDATA_CONTENT_TYPE}"/>`);
    expect(registerFntdataContentType(once, ['ppt/fonts/font2.fntdata'])).toBe(once);
    const other = ct.replace('</Types>', '<Default Extension="fntdata" ContentType="application/x-font-ttf"/></Types>');
    expect(registerFntdataContentType(other, ['ppt/fonts/font2.fntdata'])).toContain(
      `<Override PartName="/ppt/fonts/font2.fntdata" ContentType="${FNTDATA_CONTENT_TYPE}"/></Types>`,
    );
  });

  it('relationship ids and the presentation part', () => {
    expect(nextRelationshipId(new Set(['rId1', 'rId7', 'rIdX', 'custom']))).toBe('rId8');
    expect(nextRelationshipId(new Set())).toBe('rId1');
    const rels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/ppt/presentation.xml"/></Relationships>';
    expect(findPresentationPart(rels)).toBe('ppt/presentation.xml');
    expect(findPresentationPart(rels.replace('/ppt/presentation.xml', 'deck/main.xml'))).toBe('deck/main.xml');
    expect(findPresentationPart('<Relationships/>')).toBeNull();
  });
});
