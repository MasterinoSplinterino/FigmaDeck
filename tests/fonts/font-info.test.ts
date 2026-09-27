/**
 * parseFontInfo / detectFontFormat / decodeFsType (src/fonts/embed.ts, EXPERIMENTAL stage 4).
 */
import { describe, expect, it } from 'vitest';
import {
  FontEmbedError,
  MAC_ROMAN_HIGH,
  decodeFsType,
  detectFontFormat,
  fontCharset,
  makeFntdata,
  panoseHex,
  parseFontInfo,
  pitchFamily,
  slotOf,
} from '../../src/fonts/embed';
import { LIBERATION_SANS, buildSfnt, hasLiberationSans, patchFsType, readFont, systemFont } from './font-files';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof FontEmbedError) return e.code;
    throw e;
  }
  return undefined;
}

const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('detectFontFormat', () => {
  it('recognizes sfnt flavors, collections, web fonts and EOT', () => {
    expect(detectFontFormat(buildSfnt())).toBe('truetype');
    expect(detectFontFormat(buildSfnt({ flavor: 'true' }))).toBe('truetype');
    expect(detectFontFormat(buildSfnt({ flavor: 'otf' }))).toBe('cff');
    expect(detectFontFormat(ascii('ttcf\u0000\u0001\u0000\u0000'))).toBe('ttc');
    expect(detectFontFormat(ascii('wOFF\u0000\u0001\u0000\u0000'))).toBe('woff');
    expect(detectFontFormat(ascii('wOF2\u0000\u0001\u0000\u0000'))).toBe('woff2');
    expect(detectFontFormat(ascii('typ1'))).toBe('type1');
    expect(detectFontFormat(ascii('<svg xmlns'))).toBe('unknown');
    expect(detectFontFormat(new Uint8Array(0))).toBe('unknown');
    expect(detectFontFormat(makeFntdata(buildSfnt()))).toBe('eot');
  });

  it('parseFontInfo refuses everything but a single TTF / OTF, with a hint', () => {
    for (const bytes of [ascii('ttcf\u0000\u0001\u0000\u0000'), ascii('wOF2xxxx'), ascii('wOFFxxxx'), ascii('garbage!'), makeFntdata(buildSfnt())]) {
      expect(errorCode(() => parseFontInfo(bytes))).toBe('unsupported-format');
    }
    expect(() => parseFontInfo(ascii('wOF2xxxx'))).toThrow(/WOFF2.*original TTF\/OTF/);
    expect(() => parseFontInfo(ascii('ttcf\u0000\u0001\u0000\u0000'))).toThrow(/collection/);
  });

  it('reports truncated / inconsistent files as malformed', () => {
    const font = buildSfnt();
    expect(errorCode(() => parseFontInfo(font.subarray(0, 40)))).toBe('malformed');
    expect(errorCode(() => parseFontInfo(buildSfnt({ omitOs2: true })))).toBe('malformed');
    expect(errorCode(() => parseFontInfo(buildSfnt({ names: { 1: '' } })))).toBe('malformed');
  });
});

describe('decodeFsType (OS/2 fsType → embedding permission)', () => {
  it.each([
    [0x0000, 'installable', true, true],
    [0x0002, 'restricted', false, false],
    [0x0004, 'preview-print', true, false],
    [0x0008, 'editable', true, true],
  ] as const)('0x%s → %s', (fsType, permission, embeddable, editable) => {
    const r = decodeFsType(fsType);
    expect(r.permission).toBe(permission);
    expect(r.embeddable).toBe(embeddable);
    expect(r.editable).toBe(editable);
    expect(r.ambiguous).toBe(false);
    expect(r.reservedBits).toBe(0);
  });

  it('bit 8 = no subsetting (still embeddable whole), bit 9 = bitmap only (not embeddable)', () => {
    expect(decodeFsType(0x0100)).toMatchObject({ permission: 'installable', noSubsetting: true, embeddable: true });
    expect(decodeFsType(0x0108)).toMatchObject({ permission: 'editable', noSubsetting: true, editable: true });
    expect(decodeFsType(0x0200)).toMatchObject({ bitmapOnly: true, embeddable: false, editable: false });
    expect(decodeFsType(0x0204)).toMatchObject({ permission: 'preview-print', bitmapOnly: true, embeddable: false });
  });

  it('several usage bits (pre-OS/2 v3 fonts): the least restrictive wins, flagged ambiguous', () => {
    expect(decodeFsType(0x000a)).toMatchObject({ permission: 'editable', ambiguous: true });
    expect(decodeFsType(0x0006)).toMatchObject({ permission: 'preview-print', ambiguous: true });
    expect(decodeFsType(0x000e)).toMatchObject({ permission: 'editable', ambiguous: true });
  });

  it('reserved bits are reported but do not change the permission', () => {
    expect(decodeFsType(0x0001)).toMatchObject({ permission: 'installable', reservedBits: 0x0001 });
    expect(decodeFsType(0x8008)).toMatchObject({ permission: 'editable', reservedBits: 0x8000 });
  });
});

describe('parseFontInfo on synthetic fonts', () => {
  it('reads names, weight, style flags, classification and licence', () => {
    const info = parseFontInfo(
      buildSfnt({
        names: { 1: 'SB Sans Display Semibold', 2: 'Italic', 4: 'SB Sans Display Semibold Italic', 16: 'SB Sans Display', 17: 'Semibold Italic' },
        weightClass: 600,
        fsSelection: 0x01,
        fsType: 0x0008,
        panose: [2, 11, 7, 3, 3, 4, 3, 2, 2, 4],
        codePageRange: [0x00000005, 0],
        checkSumAdjustment: 0xb1b0afba,
      }),
    );
    expect(info).toMatchObject({
      format: 'truetype',
      family: 'SB Sans Display Semibold',
      subfamily: 'Italic',
      fullName: 'SB Sans Display Semibold Italic',
      typographicFamily: 'SB Sans Display',
      typographicSubfamily: 'Semibold Italic',
      weightClass: 600,
      bold: false,
      italic: true,
      os2Version: 4,
      checkSumAdjustment: 0xb1b0afba,
      codePageRange: [5, 0],
    });
    expect(info.embedding.permission).toBe('editable');
    expect(info.panose).toEqual([2, 11, 7, 3, 3, 4, 3, 2, 2, 4]);
    expect(slotOf(info.bold, info.italic)).toBe('italic');
  });

  it('bold / italic come from fsSelection or head.macStyle', () => {
    expect(parseFontInfo(buildSfnt({ fsSelection: 0x20 })).bold).toBe(true);
    expect(parseFontInfo(buildSfnt({ fsSelection: 0x40, macStyle: 0x01 })).bold).toBe(true);
    expect(parseFontInfo(buildSfnt({ fsSelection: 0x40, macStyle: 0x02 })).italic).toBe(true);
    const plain = parseFontInfo(buildSfnt({ fsSelection: 0x40, macStyle: 0 }));
    expect([plain.bold, plain.italic]).toEqual([false, false]);
  });

  it('prefers Windows en-US names over other languages, Unicode-platform and Mac records', () => {
    const info = parseFontInfo(
      buildSfnt({
        names: { 1: 'Brand Sans' },
        extraNames: [
          { platform: 3, encoding: 1, language: 0x0419, nameId: 1, text: 'Бренд Санс' },
          { platform: 1, encoding: 0, language: 0, nameId: 1, text: 'Mac Name' },
          { platform: 0, encoding: 3, language: 0, nameId: 1, text: 'Unicode Name' },
        ],
      }),
    );
    expect(info.family).toBe('Brand Sans');
  });

  it('falls back to other Windows languages, then the Unicode platform, then Mac Roman', () => {
    // Name ID 16 has no Windows en-US record in these fonts, only the given ones.
    const only = (records: Array<{ platform: number; encoding: number; language: number; text: string }>) =>
      parseFontInfo(buildSfnt({ extraNames: records.map((r) => ({ ...r, nameId: 16 })) })).typographicFamily;
    expect(only([{ platform: 3, encoding: 1, language: 0x0419, text: 'Русский' }, { platform: 1, encoding: 0, language: 0, text: 'Mac' }])).toBe('Русский');
    expect(only([{ platform: 0, encoding: 4, language: 0, text: 'Unicode' }, { platform: 1, encoding: 0, language: 0, text: 'Mac' }])).toBe('Unicode');
    // Mac Roman byte 0x8E is "é" (the synthetic builder writes char codes as single bytes).
    expect(only([{ platform: 1, encoding: 0, language: 0, text: 'Caf\u008e' }])).toBe('Café');
    // Mac records in other scripts / languages are ignored.
    expect(only([{ platform: 1, encoding: 1, language: 11, text: 'Japanese' }])).toBeNull();
  });

  it('Mac Roman high half matches the platform decoder (when Node has it)', () => {
    let decoder: TextDecoder | null = null;
    try {
      decoder = new TextDecoder('macintosh');
    } catch {
      decoder = null;
    }
    expect(MAC_ROMAN_HIGH).toHaveLength(128);
    if (!decoder) return;
    const bytes = new Uint8Array(128).map((_, i) => 0x80 + i);
    expect(MAC_ROMAN_HIGH).toBe(decoder.decode(bytes));
  });

  it('OS/2 version 0 has no code page ranges', () => {
    const info = parseFontInfo(buildSfnt({ os2Version: 0, codePageRange: [0xffffffff, 0xffffffff] }));
    expect(info.os2Version).toBe(0);
    expect(info.codePageRange).toEqual([0, 0]);
  });

  it('pitchFamily / charset / panose attributes', () => {
    const sans = parseFontInfo(buildSfnt({ panose: [2, 11, 6, 4, 2, 2, 2, 2, 2, 4] }));
    expect(pitchFamily(sans)).toBe(0x22); // swiss, variable = 34 (what PowerPoint writes for Calibri / Arial)
    expect(pitchFamily(parseFontInfo(buildSfnt({ panose: [2, 2, 6, 3, 5, 4, 5, 2, 3, 4] })))).toBe(0x12); // roman
    expect(pitchFamily(parseFontInfo(buildSfnt({ fixedPitch: true })))).toBe(0x31); // modern, fixed
    expect(pitchFamily(parseFontInfo(buildSfnt({ panose: [3, 1, 1, 1, 1, 1, 1, 1, 1, 1] })))).toBe(0x42); // script
    expect(pitchFamily(parseFontInfo(buildSfnt({ panose: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })))).toBe(0x02);
    expect(panoseHex(sans)).toBe('020B0604020202020204');
    expect(panoseHex(parseFontInfo(buildSfnt({ panose: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })))).toBeNull();
    expect(fontCharset(sans)).toBe(0);
    expect(fontCharset(parseFontInfo(buildSfnt({ codePageRange: [0x80000001, 0] })))).toBe(2); // symbol
    expect(fontCharset(parseFontInfo(buildSfnt({ codePageRange: [0x00000004, 0] })))).toBe(1); // Cyrillic only
  });
});

describe.skipIf(!hasLiberationSans())('parseFontInfo on real system fonts (Liberation Sans)', () => {
  it('reads the four RIBBI members', () => {
    const got = Object.entries(LIBERATION_SANS).map(([slot, path]) => {
      const i = parseFontInfo(readFont(path));
      return { slot, family: i.family, subfamily: i.subfamily, weight: i.weightClass, style: slotOf(i.bold, i.italic), format: i.format };
    });
    expect(got).toEqual([
      { slot: 'regular', family: 'Liberation Sans', subfamily: 'Regular', weight: 400, style: 'regular', format: 'truetype' },
      { slot: 'bold', family: 'Liberation Sans', subfamily: 'Bold', weight: 700, style: 'bold', format: 'truetype' },
      { slot: 'italic', family: 'Liberation Sans', subfamily: 'Italic', weight: 400, style: 'italic', format: 'truetype' },
      { slot: 'boldItalic', family: 'Liberation Sans', subfamily: 'Bold Italic', weight: 700, style: 'boldItalic', format: 'truetype' },
    ]);
    const regular = parseFontInfo(readFont(LIBERATION_SANS.regular));
    expect(regular.embedding.permission).toBe('installable');
    expect(regular.postScriptName).toBe('LiberationSans');
    expect(pitchFamily(regular)).toBe(0x22);
  });

  it('a synthetic restricted copy (only the fsType bytes patched) is reported as restricted', () => {
    // Only OS/2 fsType changes; table checksums / checkSumAdjustment are left stale on purpose (see patchFsType):
    // the licence bits alone must decide, and nothing in the parser depends on checksums.
    const restricted = patchFsType(readFont(LIBERATION_SANS.regular), 0x0002);
    const info = parseFontInfo(restricted);
    expect(info.embedding).toMatchObject({ fsType: 2, permission: 'restricted', embeddable: false, editable: false });
    expect(info.family).toBe('Liberation Sans');
  });
});

describe('other real font files (when present)', () => {
  const otf = systemFont('otf');
  const ttc = systemFont('ttc');

  it.skipIf(!otf)('an OTF with CFF outlines parses as format "cff"', () => {
    const info = parseFontInfo(readFont(otf as string));
    expect(info.format).toBe('cff');
    expect(info.family.length).toBeGreaterThan(0);
  });

  it.skipIf(!ttc)('a TTC collection is refused', () => {
    expect(errorCode(() => parseFontInfo(readFont(ttc as string)))).toBe('unsupported-format');
  });
});
