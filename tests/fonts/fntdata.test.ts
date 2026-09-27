/**
 * `.fntdata` = EOT 2.2 container (src/fonts/embed.ts, EXPERIMENTAL stage 4).
 * The byte layout is the one LibreOffice's EOTConverter and pptxboss write (see docs/font-embedding.md);
 * offsets below are bytes from the start of the part, all fields little-endian.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import {
  EOT_VERSION_2_2,
  FontEmbedError,
  TTEMBED_TTCOMPRESSED,
  TTEMBED_XORENCRYPTDATA,
  extractFontFromFntdata,
  makeFntdata,
  parseFontInfo,
  readEotHeader,
} from '../../src/fonts/embed';
import { LIBERATION_SANS, buildSfnt, hasLiberationSans, readFont } from './font-files';

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const utf16le = (s: string) => [...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);

describe('makeFntdata (EOT 2.2 header + uncompressed font)', () => {
  const font = buildSfnt({
    names: { 1: 'Boxy', 2: 'Regular', 4: 'Boxy Regular', 5: 'Version 1.000' },
    weightClass: 400,
    fsType: 0x0008,
    fsSelection: 0x40,
    panose: [2, 11, 5, 3, 2, 2, 2, 2, 2, 4],
    unicodeRange: [0xe00002ff, 0x4000205b, 0x00000001, 0x00000000],
    codePageRange: [0x2000019f, 0x00000000],
    checkSumAdjustment: 0x0b1ecafe,
  });
  const eot = makeFntdata(font);

  it('writes the fixed header fields at their offsets', () => {
    expect(le32(eot, 0)).toBe(eot.length); // EOTSize
    expect(le32(eot, 4)).toBe(font.length); // FontDataSize
    expect(le32(eot, 8)).toBe(EOT_VERSION_2_2);
    expect(le32(eot, 12)).toBe(0); // Flags: not subset, not compressed, not XOR-ed
    expect([...eot.subarray(16, 26)]).toEqual([2, 11, 5, 3, 2, 2, 2, 2, 2, 4]); // PANOSE
    expect(eot[26]).toBe(CONFIG.fontEmbed.eotCharset);
    expect(eot[27]).toBe(0); // Italic
    expect(le32(eot, 28)).toBe(400); // Weight
    expect(le16(eot, 32)).toBe(0x0008); // fsType copied verbatim
    expect(le16(eot, 34)).toBe(0x504c); // MagicNumber
    expect([le32(eot, 36), le32(eot, 40), le32(eot, 44), le32(eot, 48)]).toEqual([0xe00002ff, 0x4000205b, 1, 0]);
    expect([le32(eot, 52), le32(eot, 56)]).toEqual([0x2000019f, 0]);
    expect(le32(eot, 60)).toBe(0x0b1ecafe); // CheckSumAdjustment
    expect([...eot.subarray(64, 80)]).toEqual(new Array(16).fill(0)); // Reserved1..4
  });

  it('writes the four names as UTF-16LE with a terminating NUL counted in the size', () => {
    expect(le16(eot, 80)).toBe(0); // Padding1
    expect(le16(eot, 82)).toBe(10); // FamilyNameSize: "Boxy" = 4 chars + NUL = 10 bytes
    expect([...eot.subarray(84, 94)]).toEqual([...utf16le('Boxy'), 0, 0]);
    let p = 94;
    for (const name of ['Regular', 'Version 1.000', 'Boxy Regular']) {
      expect(le16(eot, p)).toBe(0); // padding
      expect(le16(eot, p + 2)).toBe((name.length + 1) * 2);
      expect([...eot.subarray(p + 4, p + 4 + name.length * 2)]).toEqual(utf16le(name));
      p += 4 + (name.length + 1) * 2;
    }
    // Padding5, RootStringSize 0, RootStringCheckSum, EUDCCodePage 1252, Padding6, SignatureSize 0, EUDCFlags, EUDCFontSize
    expect(le16(eot, p)).toBe(0);
    expect(le16(eot, p + 2)).toBe(0);
    expect(le32(eot, p + 4)).toBe(0x50475342);
    expect(le32(eot, p + 8)).toBe(1252);
    expect([...eot.subarray(p + 12, p + 24)]).toEqual(new Array(12).fill(0));
    expect(p + 24).toBe(eot.length - font.length); // FontData follows immediately
    expect([...eot.subarray(p + 24)]).toEqual([...font]);
  });

  it('round-trips through readEotHeader / extractFontFromFntdata', () => {
    const h = readEotHeader(eot);
    expect(h).toMatchObject({
      eotSize: eot.length,
      fontDataSize: font.length,
      version: EOT_VERSION_2_2,
      flags: 0,
      italic: false,
      weight: 400,
      fsType: 8,
      familyName: 'Boxy',
      styleName: 'Regular',
      versionName: 'Version 1.000',
      fullName: 'Boxy Regular',
      rootString: '',
      rootStringCheckSum: 0x50475342,
      eudcCodePage: 1252,
      eudcFontSize: 0,
    });
    expect(extractFontFromFntdata(eot)).toEqual(font);
  });

  it('writes an empty name as size 0 without terminator', () => {
    const e = makeFntdata(buildSfnt({ names: { 5: '' } }));
    expect(readEotHeader(e).versionName).toBe('');
    expect(extractFontFromFntdata(e).length).toBe(le32(e, 4));
  });

  it('marks italic fonts and keeps CFF data as is', () => {
    const otf = buildSfnt({ flavor: 'otf', fsSelection: 0x01, weightClass: 300 });
    const e = makeFntdata(otf);
    expect(e[27]).toBe(1);
    expect(le32(e, 28)).toBe(300);
    expect(extractFontFromFntdata(e)).toEqual(otf);
  });

  it('decrypts XOR-obfuscated data and refuses MTX-compressed data', () => {
    const eotXor = makeFntdata(font);
    const h = readEotHeader(eotXor);
    const flags = new DataView(eotXor.buffer);
    flags.setUint32(12, TTEMBED_XORENCRYPTDATA, true);
    for (let i = h.fontDataOffset; i < eotXor.length; i++) eotXor[i] ^= 0x50;
    expect(extractFontFromFntdata(eotXor)).toEqual(font);

    const eotMtx = makeFntdata(font);
    new DataView(eotMtx.buffer).setUint32(12, TTEMBED_TTCOMPRESSED, true);
    expect(() => extractFontFromFntdata(eotMtx)).toThrow(FontEmbedError);
    try {
      extractFontFromFntdata(eotMtx);
    } catch (e) {
      expect((e as FontEmbedError).code).toBe('compressed');
    }
  });

  it('rejects truncated EOT streams', () => {
    expect(() => readEotHeader(eot.subarray(0, 90))).toThrow(/truncated/);
    expect(() => readEotHeader(eot.subarray(0, eot.length - 1))).toThrow(/truncated/);
    expect(() => readEotHeader(font)).toThrow(/Not an EOT/);
  });
});

describe.skipIf(!hasLiberationSans())('makeFntdata with a real font', () => {
  it('wraps Liberation Sans Bold Italic without touching the font bytes', () => {
    const ttf = readFont(LIBERATION_SANS.boldItalic);
    const info = parseFontInfo(ttf);
    const eot = makeFntdata(ttf, info);
    const h = readEotHeader(eot);
    expect(h).toMatchObject({ familyName: 'Liberation Sans', styleName: 'Bold Italic', italic: true, weight: 700, fsType: 0 });
    expect(h.panose).toEqual(info.panose);
    expect(h.checkSumAdjustment).toBe(info.checkSumAdjustment);
    expect(extractFontFromFntdata(eot)).toEqual(ttf);
    expect(eot.length - ttf.length).toBeLessThan(400); // header only
  });
});
