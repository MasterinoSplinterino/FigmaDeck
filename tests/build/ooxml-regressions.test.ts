/**
 * Regressions found by the OOXML / XSD review, plus strict XSD validation of the PresentationML parts
 * against the ISO/IEC 29500-4 Transitional schemas (skipped when the schemas are not available:
 * set FIGMADECK_OOXML_SCHEMAS to the directory that contains pml.xsd and dml-main.xsd).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import type { Deck, ShapeElement, TextElement } from '../../src/ir/types';
import { FIXTURE_NAMES, loadFixture, testOptions } from '../fixtures/load';
import { openPptx, slideXml, tagAttrs } from '../helpers/ooxml';

const INT32 = 2147483647;

function baseDeck(elements: Deck['slides'][number]['elements'], name = 'Slide'): Deck {
  return {
    irVersion: 1,
    meta: { title: 'Regression' },
    slides: [{ id: '1:1', name, width: 800, height: 600, background: null, elements }],
    assets: {},
    report: [],
  };
}

const style = {
  fontFamily: 'Inter',
  fontStyle: 'Regular',
  fontWeight: 400,
  fontSize: 20,
  lineHeight: { unit: 'AUTO' as const },
  letterSpacing: { unit: 'PERCENT' as const, value: 0 },
  color: { r: 0, g: 0, b: 0, a: 1 },
  decoration: 'none' as const,
  textCase: 'ORIGINAL' as const,
  hyperlink: null,
};

function text(id: string, t: string, rotation = 0): TextElement {
  return {
    type: 'text',
    id,
    name: t,
    transform: { x: 10, y: 10, w: 300, h: 40, rotation, flipH: false, flipV: false },
    opacity: 1,
    verticalAlign: 'top',
    autoResize: 'NONE',
    paragraphs: [{ align: 'left', spaceAfter: 0, firstLineIndent: 0, list: null, runs: [{ ...style, text: t }], endStyle: style }],
  };
}

function rect(id: string, patch: Partial<ShapeElement>): ShapeElement {
  return {
    type: 'shape',
    id,
    name: id,
    transform: { x: 0, y: 0, w: 100, h: 100, rotation: 0, flipH: false, flipV: false },
    opacity: 1,
    geometry: 'rect',
    cornerRadius: 0,
    fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } },
    stroke: null,
    ...patch,
  };
}

async function build(deck: Deck) {
  const result = await buildPptx(deck, testOptions());
  return openPptx(result.data);
}

describe('OOXML regressions', () => {
  it.each(['Revenue US$&EUR', "Price $' tail", 'Price $` head', 'Double $$ sign', 'Quote " & <tag>'])(
    'slide name %j stays escaped and well-formed',
    async (name) => {
      const pkg = await build(baseDeck([text('2:1', 'x')], name));
      const xml = slideXml(pkg, 1);
      expect(XMLValidator.validate(xml)).toBe(true);
      const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      expect(xml).toContain(`<p:cSld name="${escaped}">`);
    },
  );

  it('clamps custom dash lengths of hairline strokes to Int32', async () => {
    const hair = rect('2:2', {
      fill: null,
      stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 0.01, align: 'center', dash: [250, 50], cap: 'none', join: 'miter', startArrow: 'none', endArrow: 'none' },
    });
    const xml = slideXml(await build(baseDeck([hair])), 1);
    for (const ds of tagAttrs(xml, 'a:ds')) {
      expect(Number(ds.d)).toBeLessThanOrEqual(INT32);
      expect(Number(ds.sp)).toBeLessThanOrEqual(INT32);
    }
    expect(tagAttrs(xml, 'a:ds').length).toBeGreaterThan(0);
  });

  it('clamps huge sizes and shadow radii to Int32', async () => {
    const huge = rect('2:3', {
      transform: { x: 0, y: 0, w: 1e9, h: 1e9, rotation: 0, flipH: false, flipV: false },
      shadow: { type: 'outer', color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 1e9, offsetY: 0, blur: 1e9, spread: 0 },
    });
    const xml = slideXml(await build(baseDeck([huge])), 1);
    for (const ext of tagAttrs(xml, 'a:ext').filter((a) => 'cx' in a)) {
      expect(Number(ext.cx)).toBeLessThanOrEqual(INT32);
      expect(Number(ext.cy)).toBeLessThanOrEqual(INT32);
    }
    for (const sh of tagAttrs(xml, 'a:outerShdw')) {
      expect(Number(sh.blurRad)).toBeLessThanOrEqual(INT32);
      expect(Number(sh.dist)).toBeLessThanOrEqual(INT32);
    }
  });

  it('normalizes rotations outside [0, 360)', async () => {
    const xml = slideXml(await build(baseDeck([text('2:4', 'rotated', 720.5), rect('2:5', { transform: { x: 0, y: 0, w: 10, h: 10, rotation: -90, flipH: false, flipV: false } })])), 1);
    const rots = [...xml.matchAll(/<a:xfrm\b[^>]*\brot="(-?\d+)"/g)].map((m) => Number(m[1]));
    expect(rots.length).toBe(2);
    for (const r of rots) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(21600000);
    }
    expect(rots).toContain(30000); // 720.5° → 0.5°
    expect(rots).toContain(16200000); // -90° → 270°
  });

  it('keeps user text mentioning PptxGenJS; docProps never name it', async () => {
    const pkg = await build(baseDeck([text('2:6', 'Made with PptxGenJS')]));
    expect(slideXml(pkg, 1)).toContain('Made with PptxGenJS');
    for (const p of pkg.parts.filter((x) => x.startsWith('docProps/'))) expect(pkg.text(p)).not.toContain('PptxGenJS');
  });

  it('keeps pptxgenjs order of <p:sldIdLst> / <p:notesMasterIdLst> (PowerPoint refuses the XSD order)', async () => {
    // Verified by bisection in PowerPoint 365: moving notesMasterIdLst before sldIdLst makes
    // PowerPoint report "can't read" for pptxgenjs packages. Keep pptxgenjs's order.
    const pres = (await build(baseDeck([text('2:7', 'x')]))).text('ppt/presentation.xml');
    const order = ['<p:sldMasterIdLst', '<p:sldIdLst', '<p:notesMasterIdLst', '<p:sldSz', '<p:notesSz'].map((t) => pres.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(pres).toContain(`<p:notesSz cx="6858000" cy="9144000"/>`);
  });
});

// ─── XSD validation ──────────────────────────────────────────────────────────

const SCHEMA_DIR = process.env.FIGMADECK_OOXML_SCHEMAS ?? '/mnt/skills/public/pptx/scripts/office/schemas/ISO-IEC29500-4_2016';
const hasXmllint = (() => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const canValidate = hasXmllint && existsSync(join(SCHEMA_DIR, 'pml.xsd')) && existsSync(join(SCHEMA_DIR, 'dml-main.xsd'));

describe.skipIf(!canValidate)('XSD validation (ISO/IEC 29500-4 Transitional)', () => {
  it.each(FIXTURE_NAMES)('%s: slides and presentation.xml are schema-valid', async (name) => {
    const dir = mkdtempSync(join(tmpdir(), 'fd-xsd-'));
    try {
      const wrapper = join(dir, 'wrapper.xsd');
      writeFileSync(
        wrapper,
        `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:figmadeck:xsd-wrapper" elementFormDefault="qualified">
  <xsd:import namespace="http://schemas.openxmlformats.org/presentationml/2006/main" schemaLocation="${join(SCHEMA_DIR, 'pml.xsd')}"/>
  <xsd:import namespace="http://schemas.openxmlformats.org/drawingml/2006/main" schemaLocation="${join(SCHEMA_DIR, 'dml-main.xsd')}"/>
</xsd:schema>`,
      );
      const result = await buildPptx(loadFixture(name), testOptions());
      const pkg = await openPptx(result.data);
      const parts = pkg.parts.filter((p) => /^ppt\/(slides\/slide\d+|presentation)\.xml$/.test(p));
      const files = parts.map((p, i) => {
        const f = join(dir, `${i}-${p.replace(/\//g, '_')}`);
        let xml = pkg.text(p);
        if (p === 'ppt/presentation.xml') {
          // Intentional deviation (see test above): PowerPoint needs pptxgenjs's order, the XSD wants
          // notesMasterIdLst first. Validate everything else by normalizing the order in this copy.
          const notes = /<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/.exec(xml);
          if (notes) xml = xml.replace(notes[0], '').replace('</p:sldMasterIdLst>', () => '</p:sldMasterIdLst>' + notes[0]);
        }
        writeFileSync(f, xml);
        return f;
      });
      let output = '';
      try {
        execFileSync('xmllint', ['--noout', '--schema', wrapper, ...files], { stdio: 'pipe', encoding: 'utf8' });
      } catch (e) {
        output = String((e as { stderr?: string }).stderr ?? e);
      }
      expect(output.split('\n').filter((l) => /error/i.test(l))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

