/**
 * EXPERIMENTAL (stage 4) — embedding TrueType / OpenType fonts into a PPTX. Not wired into the UI.
 * Research, sources and open questions: docs/font-embedding.md.
 *
 * The Figma Plugin API gives no access to font binaries, so the font files come from the user
 * (TTF / OTF dropped into the UI). The flow this module supports:
 *
 *   const info = parseFontInfo(ttf);          // names, weight, italic, OS/2 fsType → embedding rights
 *   const out = await embedFontsIntoPptx(pptx, [{ face: 'SB Sans Display', bold: false, italic: false, bytes: ttf }]);
 *
 * Package changes (string-level edits, namespace prefixes and unknown markup stay untouched):
 *   ppt/fonts/fontN.fntdata          EOT 2.2 container (version 0x00020002), font data NOT MicroType-Express
 *                                    compressed, NOT XOR-encrypted (flags = 0) — the layout LibreOffice ≥ 25.8
 *                                    writes. PowerPoint itself writes MTX-compressed EOT; it is not verified
 *                                    here that PowerPoint accepts uncompressed EOT (see the doc).
 *   [Content_Types].xml              <Default Extension="fntdata" ContentType="application/x-fontdata"/>
 *   ppt/_rels/presentation.xml.rels  <Relationship Type="…/relationships/font" Target="fonts/fontN.fntdata"/>
 *   ppt/presentation.xml             embedTrueTypeFonts="1" + <p:embeddedFontLst> right after <p:notesSz>
 *                                    (ECMA-376 CT_Presentation sequence; other children are never reordered)
 *
 * Fonts whose OS/2 fsType forbids embedding (Restricted License, bitmap-only) are refused.
 *
 * Environment-neutral: no DOM, no Node built-ins (JSZip only). All binary offsets below are in bytes;
 * sfnt fields are big-endian, EOT fields little-endian.
 */
import JSZip from 'jszip';
import { CONFIG } from '../config';
import { escapeXml } from '../build/xml';

// ─── Errors & warnings ───────────────────────────────────────────────────────

export type FontEmbedErrorCode =
  /** Not a single TrueType / OpenType font (collection, web font container, EOT, Type 1, garbage). */
  | 'unsupported-format'
  /** Truncated or inconsistent sfnt / EOT data. */
  | 'malformed'
  /** OS/2 fsType = Restricted License embedding: the font must not be embedded. */
  | 'restricted'
  /** OS/2 fsType bit 9: only bitmaps may be embedded (outline embedding is not allowed). */
  | 'bitmap-only'
  /** OS/2 fsType = Preview & Print while `allowPreviewPrint` is false. */
  | 'preview-print'
  /** CFF-flavored OpenType while `allowCff` is false. */
  | 'cff-not-allowed'
  | 'too-large'
  | 'empty-face'
  /** Two fonts for the same face + slot (regular / bold / italic / bold italic). */
  | 'duplicate-slot'
  /** The face is already listed in the package's `<p:embeddedFontLst>`. */
  | 'already-embedded'
  /** The input is not a PPTX package this module can edit. */
  | 'invalid-package'
  /** MTX-compressed EOT data (PowerPoint-written .fntdata) — decompression is not implemented. */
  | 'compressed';

export class FontEmbedError extends Error {
  readonly code: FontEmbedErrorCode;
  /** Face the error is about (when known). */
  readonly face?: string;

  constructor(code: FontEmbedErrorCode, message: string, face?: string) {
    super(message);
    this.name = 'FontEmbedError';
    this.code = code;
    this.face = face;
  }
}

export type EmbedWarningCode =
  /** Preview & Print font: PowerPoint opens the file read-only where the font is not installed. */
  | 'preview-print'
  /** CFF (PostScript) outlines: PowerPoint support unverified. */
  | 'cff-outlines'
  /** The requested face differs from the font's own family name (name ID 1). */
  | 'face-mismatch'
  /** The slot (bold / italic) disagrees with the font's own style flags. */
  | 'style-mismatch'
  /** fsType has several usage bits (pre-OS/2 v3 font: least restrictive wins) or reserved bits set. */
  | 'fstype-unusual';

export interface EmbedWarning {
  code: EmbedWarningCode;
  face: string;
  slot: FontSlot;
  message: string;
}

// ─── Binary helpers ──────────────────────────────────────────────────────────

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function tag4(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Growable little-endian byte writer (EOT header). */
class LeWriter {
  private buf = new Uint8Array(512);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
  }

  u16(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
  }

  u32(v: number): void {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }

  bytes(b: ArrayLike<number>): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  patchU32(at: number, v: number): void {
    this.buf[at] = v & 0xff;
    this.buf[at + 1] = (v >>> 8) & 0xff;
    this.buf[at + 2] = (v >>> 16) & 0xff;
    this.buf[at + 3] = (v >>> 24) & 0xff;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

// ─── Format detection ────────────────────────────────────────────────────────

export type FontFormat =
  /** sfnt with TrueType outlines (0x00010000 or Apple 'true'). */
  | 'truetype'
  /** sfnt with CFF / CFF2 (PostScript) outlines ('OTTO'). */
  | 'cff'
  /** TrueType / OpenType collection ('ttcf'). */
  | 'ttc'
  | 'woff'
  | 'woff2'
  /** Embedded OpenType (.eot / PowerPoint .fntdata). */
  | 'eot'
  /** Apple 'typ1' sfnt-wrapped Type 1 font. */
  | 'type1'
  | 'unknown';

const EOT_MAGIC = 0x504c;
const EOT_VERSIONS = [0x00010000, 0x00020001, 0x00020002];

export function detectFontFormat(bytes: Uint8Array): FontFormat {
  if (bytes.length >= 36 && EOT_VERSIONS.includes(u32le(bytes, 8)) && u16le(bytes, 34) === EOT_MAGIC) return 'eot';
  if (bytes.length < 4) return 'unknown';
  const sig = u32be(bytes, 0);
  if (sig === 0x00010000) return 'truetype';
  switch (tag4(bytes, 0)) {
    case 'true':
      return 'truetype';
    case 'OTTO':
      return 'cff';
    case 'ttcf':
      return 'ttc';
    case 'wOFF':
      return 'woff';
    case 'wOF2':
      return 'woff2';
    case 'typ1':
      return 'type1';
    default:
      return 'unknown';
  }
}

const UNSUPPORTED_HINT: Record<Exclude<FontFormat, 'truetype' | 'cff'>, string> = {
  ttc: 'a font collection (TTC/OTC): extract the single face (e.g. with fontTools) and use its TTF/OTF',
  woff: 'a WOFF web font container: use the original TTF/OTF',
  woff2: 'a WOFF2 web font container: use the original TTF/OTF',
  eot: 'already an Embedded OpenType (EOT) file: use the original TTF/OTF',
  type1: 'a Type 1 (PostScript) font, which PowerPoint cannot embed',
  unknown: 'not a TrueType/OpenType font file',
};

// ─── sfnt tables ─────────────────────────────────────────────────────────────

interface TableRecord {
  offset: number;
  length: number;
}

function readTableDirectory(bytes: Uint8Array): Map<string, TableRecord> {
  if (bytes.length < 12) throw new FontEmbedError('malformed', 'Font file is truncated (no table directory).');
  const numTables = u16be(bytes, 4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.length) {
    throw new FontEmbedError('malformed', `Font table directory is inconsistent (${numTables} tables).`);
  }
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const offset = u32be(bytes, rec + 8);
    const length = u32be(bytes, rec + 12);
    if (offset + length > bytes.length) {
      throw new FontEmbedError('malformed', `Font table "${tag4(bytes, rec)}" points outside the file.`);
    }
    tables.set(tag4(bytes, rec), { offset, length });
  }
  return tables;
}

function requireTable(tables: Map<string, TableRecord>, tag: string, minLength: number): TableRecord {
  const t = tables.get(tag);
  if (!t) throw new FontEmbedError('malformed', `Font has no "${tag}" table.`);
  if (t.length < minLength) throw new FontEmbedError('malformed', `Font "${tag}" table is too short (${t.length} bytes).`);
  return t;
}

/** Mac OS Roman, bytes 0x80..0xFF (0x00..0x7F = ASCII). */
export const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü' +
  '†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ' +
  '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function decodeUtf16be(b: Uint8Array, start: number, length: number): string {
  let s = '';
  for (let i = start; i + 1 < start + length; i += 2) s += String.fromCharCode(u16be(b, i));
  return s;
}

function decodeMacRoman(b: Uint8Array, start: number, length: number): string {
  let s = '';
  for (let i = start; i < start + length; i++) s += b[i] < 0x80 ? String.fromCharCode(b[i]) : MAC_ROMAN_HIGH[b[i] - 0x80];
  return s;
}

/**
 * Name table strings by name ID, choosing per ID the record Windows would use for an English UI:
 * Windows Unicode en-US > other English > any Windows Unicode > Unicode platform > Mac Roman English.
 * Records in other encodings (legacy CJK code pages, other Mac scripts) are ignored.
 */
export function readNameTable(bytes: Uint8Array, table: TableRecord): Map<number, string> {
  const base = table.offset;
  const end = base + table.length;
  const count = u16be(bytes, base + 2);
  const storage = base + u16be(bytes, base + 4);
  if (base + 6 + count * 12 > end) throw new FontEmbedError('malformed', 'Font "name" table is truncated.');
  const best = new Map<number, { rank: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12;
    const platform = u16be(bytes, rec);
    const encoding = u16be(bytes, rec + 2);
    const language = u16be(bytes, rec + 4);
    const nameId = u16be(bytes, rec + 6);
    const length = u16be(bytes, rec + 8);
    const start = storage + u16be(bytes, rec + 10);
    if (start + length > end) continue; // broken record: skip rather than fail the whole font
    let rank: number;
    let text: string;
    if (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10)) {
      rank = language === 0x0409 ? 5 : (language & 0x3ff) === 0x09 ? 4 : 3;
      text = decodeUtf16be(bytes, start, length);
    } else if (platform === 0) {
      rank = 2;
      text = decodeUtf16be(bytes, start, length);
    } else if (platform === 1 && encoding === 0 && language === 0) {
      rank = 1;
      text = decodeMacRoman(bytes, start, length);
    } else {
      continue;
    }
    text = text.replace(/\u0000+$/, '');
    const prev = best.get(nameId);
    if (!prev || rank > prev.rank) best.set(nameId, { rank, text });
  }
  const out = new Map<number, string>();
  for (const [id, v] of best) out.set(id, v.text);
  return out;
}

// ─── Embedding permissions (OS/2 fsType) ─────────────────────────────────────

export type EmbeddingPermission =
  /** 0x0000 — may be embedded and even installed permanently on the recipient's system. */
  | 'installable'
  /** 0x0008 — may be embedded; documents may be edited. */
  | 'editable'
  /** 0x0004 — may be embedded; documents must be opened read-only. */
  | 'preview-print'
  /** 0x0002 — must not be embedded without the legal owner's permission. */
  | 'restricted';

export interface EmbeddingRights {
  fsType: number;
  permission: EmbeddingPermission;
  /** Bit 8 (0x0100): the font must not be subsetted before embedding. */
  noSubsetting: boolean;
  /** Bit 9 (0x0200): only bitmaps may be embedded (no outlines). */
  bitmapOnly: boolean;
  /** Outline embedding allowed (not restricted, not bitmap-only). */
  embeddable: boolean;
  /** A document carrying the embedded font may be edited by the recipient. */
  editable: boolean;
  /**
   * More than one of the usage bits 1–3 is set. Invalid since OS/2 version 3; for older fonts the
   * OpenType spec says the least restrictive permission wins, which is what `permission` reports.
   */
  ambiguous: boolean;
  /** Reserved bits that are set (0, 4–7, 10–15), normally 0. */
  reservedBits: number;
}

const FS_RESTRICTED = 0x0002;
const FS_PREVIEW_PRINT = 0x0004;
const FS_EDITABLE = 0x0008;
const FS_USAGE_MASK = FS_RESTRICTED | FS_PREVIEW_PRINT | FS_EDITABLE;
const FS_NO_SUBSETTING = 0x0100;
const FS_BITMAP_ONLY = 0x0200;

/** Decode OS/2 `fsType` (OpenType spec, OS/2 table, "fsType"). */
export function decodeFsType(fsType: number): EmbeddingRights {
  const usage = fsType & FS_USAGE_MASK;
  let permission: EmbeddingPermission;
  if (usage === 0) permission = 'installable';
  else if (usage & FS_EDITABLE) permission = 'editable';
  else if (usage & FS_PREVIEW_PRINT) permission = 'preview-print';
  else permission = 'restricted';
  const bitmapOnly = (fsType & FS_BITMAP_ONLY) !== 0;
  const embeddable = permission !== 'restricted' && !bitmapOnly;
  const usageBits = ((usage >> 1) & 1) + ((usage >> 2) & 1) + ((usage >> 3) & 1);
  return {
    fsType,
    permission,
    noSubsetting: (fsType & FS_NO_SUBSETTING) !== 0,
    bitmapOnly,
    embeddable,
    editable: embeddable && (permission === 'installable' || permission === 'editable'),
    ambiguous: usageBits > 1,
    reservedBits: fsType & ~(FS_USAGE_MASK | FS_NO_SUBSETTING | FS_BITMAP_ONLY) & 0xffff,
  };
}

// ─── Font info ───────────────────────────────────────────────────────────────

export interface FontInfo {
  format: 'truetype' | 'cff';
  /** Name ID 1: legacy ("RIBBI") family — the typeface name Windows and PowerPoint use, e.g. "SB Sans Display Semibold". */
  family: string;
  /** Name ID 2: Regular / Bold / Italic / Bold Italic for RIBBI-style fonts. */
  subfamily: string;
  /** Name ID 4, e.g. "SB Sans Display Semibold Italic". */
  fullName: string;
  /** Name ID 5, e.g. "Version 2.001". */
  version: string;
  /** Name ID 6. */
  postScriptName: string;
  /** Name ID 16 (typographic family, e.g. "SB Sans Display"), `null` when absent (then = `family`). */
  typographicFamily: string | null;
  /** Name ID 17 (typographic subfamily, e.g. "Semibold Italic"), `null` when absent (then = `subfamily`). */
  typographicSubfamily: string | null;
  /** OS/2 usWeightClass (100..900; 400 regular, 700 bold). */
  weightClass: number;
  /** OS/2 usWidthClass (1..9; 5 normal). */
  widthClass: number;
  /** OS/2 fsSelection bit 5 (BOLD) or head.macStyle bit 0 — the RIBBI "bold" member. */
  bold: boolean;
  /** OS/2 fsSelection bit 0 (ITALIC) or head.macStyle bit 1. */
  italic: boolean;
  os2Version: number;
  embedding: EmbeddingRights;
  /** OS/2 PANOSE classification, 10 bytes. */
  panose: number[];
  /** OS/2 ulUnicodeRange1..4. */
  unicodeRange: [number, number, number, number];
  /** OS/2 ulCodePageRange1..2 (0 for OS/2 version 0). */
  codePageRange: [number, number];
  /** head.checkSumAdjustment (copied into the EOT header). */
  checkSumAdjustment: number;
  /** post.isFixedPitch ≠ 0 (monospaced). */
  fixedPitch: boolean;
}

/**
 * Parse the naming / classification / licensing data of a single TrueType or OpenType font.
 * Throws `FontEmbedError` ('unsupported-format' | 'malformed').
 * Table checksums are not verified (renderers do not verify them either).
 */
export function parseFontInfo(bytes: Uint8Array): FontInfo {
  const format = detectFontFormat(bytes);
  if (format !== 'truetype' && format !== 'cff') {
    throw new FontEmbedError('unsupported-format', `The file is ${UNSUPPORTED_HINT[format]}.`);
  }
  const tables = readTableDirectory(bytes);
  // OS/2 v0 as originally defined by Apple/Microsoft is 78 bytes; fsSelection ends at byte 64.
  const os2 = requireTable(tables, 'OS/2', 64);
  const head = requireTable(tables, 'head', 54);
  const name = requireTable(tables, 'name', 6);
  const names = readNameTable(bytes, name);

  const o = os2.offset;
  const os2Version = u16be(bytes, o);
  const fsSelection = u16be(bytes, o + 62);
  const macStyle = u16be(bytes, head.offset + 44);
  const hasCodePages = os2Version >= 1 && os2.length >= 86;
  const post = tables.get('post');

  const family = names.get(1) ?? '';
  if (!family.trim()) throw new FontEmbedError('malformed', 'Font has no usable family name (name ID 1).');
  const subfamily = names.get(2) ?? 'Regular';

  return {
    format,
    family,
    subfamily,
    fullName: names.get(4) ?? `${family} ${subfamily}`,
    version: names.get(5) ?? '',
    postScriptName: names.get(6) ?? '',
    typographicFamily: names.get(16) ?? null,
    typographicSubfamily: names.get(17) ?? null,
    weightClass: u16be(bytes, o + 4),
    widthClass: u16be(bytes, o + 6),
    bold: (fsSelection & 0x20) !== 0 || (macStyle & 0x01) !== 0,
    italic: (fsSelection & 0x01) !== 0 || (macStyle & 0x02) !== 0,
    os2Version,
    embedding: decodeFsType(u16be(bytes, o + 8)),
    panose: Array.from(bytes.subarray(o + 32, o + 42)),
    unicodeRange: [u32be(bytes, o + 42), u32be(bytes, o + 46), u32be(bytes, o + 50), u32be(bytes, o + 54)],
    codePageRange: hasCodePages ? [u32be(bytes, o + 78), u32be(bytes, o + 82)] : [0, 0],
    checkSumAdjustment: u32be(bytes, head.offset + 8),
    fixedPitch: post !== undefined && post.length >= 16 && u32be(bytes, post.offset + 12) !== 0,
  };
}

/**
 * `pitchFamily` of `<p:font>` (Windows LOGFONT lfPitchAndFamily): pitch in the low nibble
 * (1 fixed, 2 variable), family in the high nibble (1 roman, 2 swiss, 3 modern, 4 script, 5 decorative),
 * derived from post.isFixedPitch and PANOSE (family kind, serif style). E.g. 34 (0x22) for a sans serif.
 */
export function pitchFamily(info: FontInfo): number {
  const fixed = info.fixedPitch || (info.panose[0] === 2 && info.panose[3] === 9);
  const pitch = fixed ? 1 : 2;
  let family = 0x00; // FF_DONTCARE
  if (fixed) family = 0x30; // FF_MODERN
  else if (info.panose[0] === 3) family = 0x40; // FF_SCRIPT
  else if (info.panose[0] === 4 || info.panose[0] === 5) family = 0x50; // FF_DECORATIVE
  else if (info.panose[0] === 2 && info.panose[1] >= 11 && info.panose[1] <= 15) family = 0x20; // FF_SWISS (sans)
  else if (info.panose[0] === 2 && info.panose[1] >= 2 && info.panose[1] <= 10) family = 0x10; // FF_ROMAN (serif)
  return family | pitch;
}

/**
 * `charset` of `<p:font>` (Windows charset id; the attribute is a signed byte): 2 SYMBOL for symbol fonts,
 * 0 ANSI when the font covers code page 1252, otherwise 1 DEFAULT_CHARSET.
 */
export function fontCharset(info: FontInfo): number {
  const cp1 = info.codePageRange[0];
  if ((cp1 & 0x80000000) !== 0) return 2;
  if ((cp1 & 0x1) !== 0 || cp1 === 0) return 0;
  return 1;
}

/** PANOSE as the 20 hex digits of `<p:font panose>`, or `null` when all zero (unknown). */
export function panoseHex(info: FontInfo): string | null {
  if (info.panose.every((b) => b === 0)) return null;
  return info.panose.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

// ─── EOT (.fntdata) ──────────────────────────────────────────────────────────

/** EOT version 2.2 — what PowerPoint, LibreOffice ≥ 25.8 and pptxboss write. */
export const EOT_VERSION_2_2 = 0x00020002;
/** EOT Flags. */
export const TTEMBED_SUBSET = 0x00000001;
export const TTEMBED_TTCOMPRESSED = 0x00000004;
export const TTEMBED_XORENCRYPTDATA = 0x10000000;
/** XOR key of TTEMBED_XORENCRYPTDATA. */
const EOT_XOR_KEY = 0x50;
/** RootStringCheckSum = (sum of RootString bytes) XOR this; for the empty root string it is the constant itself. */
const EOT_ROOT_CHECKSUM_KEY = 0x50475342;
/** EUDCCodePage written when no EUDC font is attached (Windows-1252). */
const EOT_EUDC_CODE_PAGE = 1252;

function writeEotName(w: LeWriter, text: string): void {
  w.u16(0); // padding
  if (!text) {
    w.u16(0);
    return;
  }
  // Size in bytes including a terminating NUL, as LibreOffice and pptxboss write it.
  w.u16((text.length + 1) * 2);
  for (let i = 0; i < text.length; i++) w.u16(text.charCodeAt(i));
  w.u16(0);
}

/**
 * Wrap a TTF / OTF as a PowerPoint `.fntdata` part: an EOT 2.2 header (fields from OS/2, head, name) followed by
 * the unmodified font (flags 0: not subsetted, not MTX-compressed, not XOR-encrypted).
 */
export function makeFntdata(fontBytes: Uint8Array, info: FontInfo = parseFontInfo(fontBytes)): Uint8Array {
  const w = new LeWriter();
  w.u32(0); // EOTSize, patched below
  w.u32(fontBytes.length); // FontDataSize
  w.u32(EOT_VERSION_2_2);
  w.u32(0); // Flags
  w.bytes(info.panose);
  w.u8(CONFIG.fontEmbed.eotCharset);
  w.u8(info.italic ? 1 : 0);
  w.u32(info.weightClass);
  w.u16(info.embedding.fsType);
  w.u16(EOT_MAGIC);
  for (const r of info.unicodeRange) w.u32(r);
  for (const r of info.codePageRange) w.u32(r);
  w.u32(info.checkSumAdjustment);
  for (let i = 0; i < 4; i++) w.u32(0); // Reserved1..4
  writeEotName(w, info.family); // Padding1, FamilyNameSize, FamilyName
  writeEotName(w, info.subfamily); // Padding2, StyleName…
  writeEotName(w, info.version); // Padding3, VersionName…
  writeEotName(w, info.fullName); // Padding4, FullName…
  w.u16(0); // Padding5
  w.u16(0); // RootStringSize (no root string: usable from any document)
  w.u32(EOT_ROOT_CHECKSUM_KEY); // RootStringCheckSum of the empty root string
  w.u32(EOT_EUDC_CODE_PAGE); // EUDCCodePage
  w.u16(0); // Padding6
  w.u16(0); // SignatureSize (reserved, 0)
  w.u32(0); // EUDCFlags
  w.u32(0); // EUDCFontSize (no EUDC font)
  w.bytes(fontBytes);
  w.patchU32(0, w.length);
  return w.result();
}

export interface EotHeader {
  eotSize: number;
  fontDataSize: number;
  version: number;
  flags: number;
  panose: number[];
  charset: number;
  italic: boolean;
  weight: number;
  fsType: number;
  unicodeRange: [number, number, number, number];
  codePageRange: [number, number];
  checkSumAdjustment: number;
  familyName: string;
  styleName: string;
  versionName: string;
  fullName: string;
  /** Version ≥ 2.1: allowed document URLs (UTF-16, NUL-separated); '' = any. */
  rootString: string;
  /** Version 2.2 only. */
  rootStringCheckSum: number | null;
  eudcCodePage: number | null;
  eudcFontSize: number;
  /** Byte offset of FontData. */
  fontDataOffset: number;
}

/** Parse an EOT header (versions 1.0, 2.1, 2.2) — for tests and for reading .fntdata parts of existing files. */
export function readEotHeader(bytes: Uint8Array): EotHeader {
  if (detectFontFormat(bytes) !== 'eot') throw new FontEmbedError('unsupported-format', 'Not an EOT (.fntdata) stream.');
  let p = 0;
  const need = (n: number) => {
    if (p + n > bytes.length) throw new FontEmbedError('malformed', 'EOT header is truncated.');
  };
  const r16 = () => {
    need(2);
    const v = u16le(bytes, p);
    p += 2;
    return v;
  };
  const r32 = () => {
    need(4);
    const v = u32le(bytes, p);
    p += 4;
    return v;
  };
  const rString = () => {
    const size = r16();
    need(size);
    let s = '';
    for (let i = 0; i + 1 < size; i += 2) s += String.fromCharCode(u16le(bytes, p + i));
    p += size;
    return s.replace(/\u0000+$/, '');
  };
  const eotSize = r32();
  const fontDataSize = r32();
  const version = r32();
  const flags = r32();
  need(16);
  const panose = Array.from(bytes.subarray(p, p + 10));
  const charset = bytes[p + 10];
  const italic = bytes[p + 11] !== 0;
  p += 12;
  const weight = r32();
  const fsType = r16();
  r16(); // magic, checked by detectFontFormat
  const unicodeRange: [number, number, number, number] = [r32(), r32(), r32(), r32()];
  const codePageRange: [number, number] = [r32(), r32()];
  const checkSumAdjustment = r32();
  p += 16; // Reserved1..4
  r16(); // Padding1
  const familyName = rString();
  r16();
  const styleName = rString();
  r16();
  const versionName = rString();
  r16();
  const fullName = rString();
  let rootString = '';
  let rootStringCheckSum: number | null = null;
  let eudcCodePage: number | null = null;
  let eudcFontSize = 0;
  if (version >= 0x00020001) {
    r16(); // Padding5
    rootString = rString();
  }
  if (version === EOT_VERSION_2_2) {
    rootStringCheckSum = r32();
    eudcCodePage = r32();
    r16(); // Padding6
    const signatureSize = r16();
    need(signatureSize);
    p += signatureSize;
    r32(); // EUDCFlags
    eudcFontSize = r32();
    need(eudcFontSize);
    p += eudcFontSize;
  }
  if (p + fontDataSize > bytes.length) throw new FontEmbedError('malformed', 'EOT font data is truncated.');
  return {
    eotSize,
    fontDataSize,
    version,
    flags,
    panose,
    charset,
    italic,
    weight,
    fsType,
    unicodeRange,
    codePageRange,
    checkSumAdjustment,
    familyName,
    styleName,
    versionName,
    fullName,
    rootString,
    rootStringCheckSum,
    eudcCodePage,
    eudcFontSize,
    fontDataOffset: p,
  };
}

/**
 * The sfnt inside a `.fntdata` / EOT stream (XOR-decrypted if needed). MTX-compressed data — what PowerPoint
 * writes — is refused with code 'compressed' (decompression is not implemented).
 */
export function extractFontFromFntdata(bytes: Uint8Array): Uint8Array {
  const h = readEotHeader(bytes);
  if (h.flags & TTEMBED_TTCOMPRESSED) {
    throw new FontEmbedError('compressed', 'The EOT font data is MicroType Express compressed; decompression is not implemented.');
  }
  const data = bytes.slice(h.fontDataOffset, h.fontDataOffset + h.fontDataSize);
  if (h.flags & TTEMBED_XORENCRYPTDATA) for (let i = 0; i < data.length; i++) data[i] ^= EOT_XOR_KEY;
  return data;
}

// ─── Planning: faces, slots, rights ──────────────────────────────────────────

export type FontSlot = 'regular' | 'bold' | 'italic' | 'boldItalic';

/** Child order inside `<p:embeddedFont>` (ECMA-376 CT_EmbeddedFontListEntry). */
export const FONT_SLOTS: readonly FontSlot[] = ['regular', 'bold', 'italic', 'boldItalic'];

export function slotOf(bold: boolean, italic: boolean): FontSlot {
  if (bold) return italic ? 'boldItalic' : 'bold';
  return italic ? 'italic' : 'regular';
}

export interface EmbedFontInput {
  /** PowerPoint typeface exactly as written to `<a:latin typeface>` (the RIBBI face from fonts/mapping.ts). */
  face: string;
  bold: boolean;
  italic: boolean;
  /** TTF / OTF file. */
  bytes: Uint8Array;
}

export interface EmbedOptions {
  /** Default CONFIG.fontEmbed.allowPreviewPrint. */
  allowPreviewPrint?: boolean;
  /** Default CONFIG.fontEmbed.allowCff. */
  allowCff?: boolean;
  onWarning?: (warning: EmbedWarning) => void;
}

export interface PlannedFont {
  face: string;
  slot: FontSlot;
  info: FontInfo;
  bytes: Uint8Array;
}

export interface PlannedFace {
  face: string;
  slots: Partial<Record<FontSlot, PlannedFont>>;
}

export interface EmbedPlan {
  faces: PlannedFace[];
  warnings: EmbedWarning[];
}

const normName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function slotLabel(slot: FontSlot): string {
  return slot === 'boldItalic' ? 'bold italic' : slot;
}

/**
 * Validate the fonts and group them by face. Throws `FontEmbedError` for anything that must not / cannot be
 * embedded; returns non-fatal findings as warnings. Pure (no package access) — the UI can call it when the
 * user drops a file.
 */
export function planFontEmbedding(fonts: ReadonlyArray<EmbedFontInput>, options: EmbedOptions = {}): EmbedPlan {
  const allowPreviewPrint = options.allowPreviewPrint ?? CONFIG.fontEmbed.allowPreviewPrint;
  const allowCff = options.allowCff ?? CONFIG.fontEmbed.allowCff;
  const faces: PlannedFace[] = [];
  const byFace = new Map<string, PlannedFace>();
  const warnings: EmbedWarning[] = [];

  for (const input of fonts) {
    const face = (input.face ?? '').trim();
    if (!face) throw new FontEmbedError('empty-face', 'A font to embed has an empty typeface name.');
    const slot = slotOf(input.bold, input.italic);
    const label = `"${face}" (${slotLabel(slot)})`;
    const warn = (code: EmbedWarningCode, message: string) => warnings.push({ code, face, slot, message });

    if (input.bytes.length > CONFIG.fontEmbed.maxFontBytes) {
      throw new FontEmbedError('too-large', `Font file for ${label} is larger than ${CONFIG.fontEmbed.maxFontBytes} bytes.`, face);
    }
    let info: FontInfo;
    try {
      info = parseFontInfo(input.bytes);
    } catch (err) {
      if (err instanceof FontEmbedError) throw new FontEmbedError(err.code, `Font file for ${label}: ${err.message}`, face);
      throw err;
    }
    const rights = info.embedding;
    const hex = `0x${rights.fsType.toString(16).padStart(4, '0')}`;
    if (rights.bitmapOnly) {
      throw new FontEmbedError('bitmap-only', `${info.fullName} (fsType ${hex}) allows bitmap embedding only; it cannot be embedded.`, face);
    }
    if (rights.permission === 'restricted') {
      throw new FontEmbedError(
        'restricted',
        `${info.fullName} (fsType ${hex}) has a Restricted License: its license does not allow embedding. Ask the font vendor for an embeddable license or let recipients install the font.`,
        face,
      );
    }
    if (rights.permission === 'preview-print') {
      const message = `${info.fullName} (fsType ${hex}) allows Preview & Print embedding only: PowerPoint opens the presentation read-only on computers without the font.`;
      if (!allowPreviewPrint) throw new FontEmbedError('preview-print', message, face);
      warn('preview-print', message);
    }
    if (rights.ambiguous || rights.reservedBits) {
      warn('fstype-unusual', `${info.fullName} has an unusual fsType ${hex}; it was read as "${rights.permission}".`);
    }
    if (info.format === 'cff') {
      const message = `${info.fullName} has CFF (PostScript) outlines; whether PowerPoint uses such embedded fonts is unverified — prefer a TrueType (.ttf) build.`;
      if (!allowCff) throw new FontEmbedError('cff-not-allowed', message, face);
      warn('cff-outlines', message);
    }
    if (normName(info.family) !== normName(face)) {
      warn(
        'face-mismatch',
        `The font's family name is "${info.family}" but the slides use "${face}". An embedded font is most likely registered under its own family name (unverified in PowerPoint), so text set in "${face}" may not use it.`,
      );
    }
    if (info.bold !== input.bold || info.italic !== input.italic) {
      const own = slotLabel(slotOf(info.bold, info.italic));
      warn('style-mismatch', `${info.fullName} is a ${own} font but is embedded as ${label}.`);
    }

    const key = normName(face);
    let entry = byFace.get(key);
    if (!entry) {
      entry = { face, slots: {} };
      byFace.set(key, entry);
      faces.push(entry);
    }
    if (entry.slots[slot]) throw new FontEmbedError('duplicate-slot', `Two fonts were given for ${label}.`, face);
    entry.slots[slot] = { face: entry.face, slot, info, bytes: input.bytes };
  }
  for (const w of warnings) options.onWarning?.(w);
  return { faces, warnings };
}

// ─── XML helpers (string level) ──────────────────────────────────────────────

const NS = {
  pml: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  pkgRels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
} as const;

/** Relationship type of a font part (ECMA-376 Part 1, §15.2.13). */
export const FONT_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';
/** Content type PowerPoint uses for `.fntdata` parts. */
export const FNTDATA_CONTENT_TYPE = 'application/x-fontdata';

/**
 * `<p:presentation>` children in schema order (ECMA-376 CT_Presentation). `embeddedFontLst` goes after the last
 * present element of the first group. (pptxgenjs writes sldIdLst before notesMasterIdLst — out of order, but
 * tolerated by PowerPoint — so nothing is ever moved, only inserted.)
 */
export const PRESENTATION_CHILDREN_BEFORE_FONTS = [
  'sldMasterIdLst',
  'notesMasterIdLst',
  'handoutMasterIdLst',
  'sldIdLst',
  'sldSz',
  'notesSz',
  'smartTags',
] as const;
export const PRESENTATION_CHILDREN_AFTER_FONTS = [
  'custShowLst',
  'photoAlbum',
  'custDataLst',
  'kinsoku',
  'defaultTextStyle',
  'modifyVerifier',
  'extLst',
] as const;

/** Start / end tags only (quoted attribute values may contain '>'); comments, PIs, CDATA and DOCTYPE are skipped. */
const TAG_RE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

export interface XmlElementSpan {
  /** Qualified name as written, e.g. "p:notesSz". */
  qname: string;
  /** Index of '<' of the start tag. */
  start: number;
  /** Index after the start tag ('>' + 1). */
  startTagEnd: number;
  /** Index after the end tag (= startTagEnd for an empty element). */
  end: number;
}

export interface XmlRootInfo {
  root: XmlElementSpan & { attrs: string };
  /** Direct children of the root element, in document order. */
  children: XmlElementSpan[];
  /** Index of the root's end tag ('</…>'); -1 for an empty root. */
  closeStart: number;
}

/** Locate the root element and its direct children (depth-aware; tolerant of attribute values with '>'). */
export function scanRoot(xml: string): XmlRootInfo {
  TAG_RE.lastIndex = 0;
  let root: (XmlElementSpan & { attrs: string }) | null = null;
  const children: XmlElementSpan[] = [];
  let depth = 0;
  let current: XmlElementSpan | null = null;
  for (let m = TAG_RE.exec(xml); m; m = TAG_RE.exec(xml)) {
    if (m[2] === undefined) continue; // comment / PI / CDATA / DOCTYPE
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/';
    const start = m.index;
    const end = m.index + m[0].length;
    if (!root) {
      if (closing) throw new FontEmbedError('invalid-package', 'XML starts with an end tag.');
      root = { qname: m[2], start, startTagEnd: end, end, attrs: m[3] };
      if (selfClosing) return { root, children, closeStart: -1 };
      depth = 1;
      continue;
    }
    if (closing) {
      depth--;
      if (depth === 0) {
        root.end = end;
        return { root, children, closeStart: start };
      }
      if (depth === 1 && current) {
        current.end = end;
        children.push(current);
        current = null;
      }
    } else if (selfClosing) {
      if (depth === 1) children.push({ qname: m[2], start, startTagEnd: end, end });
    } else {
      if (depth === 1) current = { qname: m[2], start, startTagEnd: end, end };
      depth++;
    }
  }
  throw new FontEmbedError('invalid-package', 'XML is not well-formed (root element not closed).');
}

/** `xmlns` declarations of a start tag's attribute string: prefix ('' = default namespace) → URI. */
export function namespaceDeclarations(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(/\sxmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.set(m[1] ?? '', m[2] ?? m[3] ?? '');
  return out;
}

function prefixFor(decls: Map<string, string>, uri: string): string | null {
  for (const [prefix, u] of decls) if (u === uri) return prefix;
  return null;
}

const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1);
const prefixOf = (qname: string) => (qname.includes(':') ? qname.slice(0, qname.indexOf(':')) : '');

/** Set (add or replace) an unprefixed attribute on the start tag at `span`. */
export function setStartTagAttribute(xml: string, span: { start: number; startTagEnd: number }, name: string, value: string): string {
  const tag = xml.slice(span.start, span.startTagEnd);
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  const next = re.test(tag)
    ? tag.replace(re, (_all, lead: string) => `${lead}"${escapeXml(value)}"`)
    : tag.replace(/\s*(\/?)>$/, (_all, slash: string) => ` ${name}="${escapeXml(value)}"${slash}>`);
  return xml.slice(0, span.start) + next + xml.slice(span.startTagEnd);
}

// ─── Package parts ───────────────────────────────────────────────────────────

function dirOf(part: string): string {
  return part.slice(0, part.lastIndexOf('/') + 1);
}

function relsPathOf(part: string): string {
  return `${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
}

/** Resolve a relationship target (relative to the source part's folder, or absolute '/…'). */
function resolvePartName(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segs: string[] = [];
  for (const s of (dirOf(sourcePart) + target).split('/')) {
    if (s === '..') segs.pop();
    else if (s !== '.' && s !== '') segs.push(s);
  }
  return segs.join('/');
}

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

/** The main presentation part named by the package's `_rels/.rels` (normally `ppt/presentation.xml`). */
export function findPresentationPart(rootRelsXml: string): string | null {
  for (const m of rootRelsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attrOf(m[0], 'Type') === NS.officeDocument) {
      const target = attrOf(m[0], 'Target');
      if (target) return resolvePartName('', target);
    }
  }
  return null;
}

/** Relationship ids already used in a `.rels` part. */
export function relationshipIds(relsXml: string): Set<string> {
  const ids = new Set<string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attrOf(m[0], 'Id');
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** Next free `rIdN` (N = max numeric suffix + 1, then the first unused). */
export function nextRelationshipId(ids: Set<string>): string {
  let max = 0;
  for (const id of ids) {
    const m = /^rId(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (ids.has(`rId${n}`)) n++;
  return `rId${n}`;
}

function appendRelationship(relsXml: string, id: string, type: string, target: string): string {
  const rel = `<Relationship Id="${escapeXml(id)}" Type="${escapeXml(type)}" Target="${escapeXml(target)}"/>`;
  const self = /<Relationships\b([^>]*)\/>/.exec(relsXml);
  if (self) return relsXml.replace(self[0], `<Relationships${self[1]}>${rel}</Relationships>`);
  const at = relsXml.lastIndexOf('</Relationships>');
  if (at < 0) throw new FontEmbedError('invalid-package', 'Relationships part is not well-formed.');
  return relsXml.slice(0, at) + rel + relsXml.slice(at);
}

/**
 * Make `.fntdata` parts resolve to `application/x-fontdata`: a `<Default>` when the extension has none, otherwise
 * (a different default already registered) an `<Override>` per new part.
 */
export function registerFntdataContentType(ctXml: string, newParts: ReadonlyArray<string>): string {
  const def = /<Default\b[^>]*\bExtension\s*=\s*"fntdata"[^>]*>/i.exec(ctXml);
  let add = '';
  if (!def) add = `<Default Extension="fntdata" ContentType="${FNTDATA_CONTENT_TYPE}"/>`;
  else if (attrOf(def[0], 'ContentType') !== FNTDATA_CONTENT_TYPE) {
    add = newParts.map((p) => `<Override PartName="/${escapeXml(p)}" ContentType="${FNTDATA_CONTENT_TYPE}"/>`).join('');
  }
  if (!add) return ctXml;
  if (!def) {
    // Defaults first, as Office writes them (the schema allows any order).
    const types = /<Types\b[^>]*>/.exec(ctXml);
    if (!types) throw new FontEmbedError('invalid-package', '[Content_Types].xml has no <Types> element.');
    return ctXml.replace(types[0], types[0] + add);
  }
  const at = ctXml.lastIndexOf('</Types>');
  if (at < 0) throw new FontEmbedError('invalid-package', '[Content_Types].xml is not well-formed.');
  return ctXml.slice(0, at) + add + ctXml.slice(at);
}

/** One `<p:embeddedFont>` to write. */
export interface EmbeddedFontEntry {
  /** `<p:font typeface>` */
  face: string;
  /** Source of `panose` / `pitchFamily` / `charset`. */
  info: FontInfo;
  /** slot → relationship id of its `.fntdata` part */
  ids: Partial<Record<FontSlot, string>>;
}

function embeddedFontXml(e: EmbeddedFontEntry, p: (local: string) => string, relPrefix: string): string {
  const panose = panoseHex(e.info);
  const font =
    `<${p('font')} typeface="${escapeXml(e.face)}"` +
    (panose ? ` panose="${panose}"` : '') +
    ` pitchFamily="${pitchFamily(e.info)}" charset="${fontCharset(e.info)}"/>`;
  const slots = FONT_SLOTS.filter((s) => e.ids[s])
    .map((s) => `<${p(s)} ${relPrefix}:id="${escapeXml(e.ids[s] as string)}"/>`)
    .join('');
  return `<${p('embeddedFont')}>${font}${slots}</${p('embeddedFont')}>`;
}

/** Typefaces already listed in an existing `<p:embeddedFontLst>`. */
function existingEmbeddedFaces(listXml: string): string[] {
  const out: string[] = [];
  for (const m of listXml.matchAll(/<(?:[\w.-]+:)?font\b[^>]*>/g)) {
    const face = attrOf(m[0], 'typeface');
    if (face !== null) out.push(face);
  }
  return out;
}

/**
 * Add `<p:embeddedFont>` entries to presentation.xml: into an existing `<p:embeddedFontLst>`, or as a new list
 * inserted after the last present element of PRESENTATION_CHILDREN_BEFORE_FONTS (else before the first of
 * PRESENTATION_CHILDREN_AFTER_FONTS, else at the end). Sets `embedTrueTypeFonts="1"`; declares the relationships
 * namespace if needed. No other element is moved.
 */
export function addEmbeddedFontsToPresentationXml(xml: string, entries: ReadonlyArray<EmbeddedFontEntry>): string {
  const scan = scanRoot(xml);
  const decls = namespaceDeclarations(scan.root.attrs);
  const pmlPrefix = prefixOf(scan.root.qname);
  if (localName(scan.root.qname) !== 'presentation' || decls.get(pmlPrefix) !== NS.pml) {
    throw new FontEmbedError('invalid-package', 'The presentation part has no PresentationML <presentation> root.');
  }
  if (scan.closeStart < 0) throw new FontEmbedError('invalid-package', 'The <presentation> element is empty.');
  let relPrefix = prefixFor(decls, NS.rel);
  let declareRel = false;
  if (relPrefix === null || relPrefix === '') {
    relPrefix = 'r';
    for (let i = 1; decls.has(relPrefix); i++) relPrefix = `r${i}`;
    declareRel = true;
  }
  const q = (local: string) => (pmlPrefix ? `${pmlPrefix}:${local}` : local);
  const items = entries.map((e) => embeddedFontXml(e, q, relPrefix as string)).join('');

  const existing = scan.children.find((c) => c.qname === q('embeddedFontLst'));
  let out: string;
  if (existing) {
    const listXml = xml.slice(existing.start, existing.end);
    const taken = new Set(existingEmbeddedFaces(listXml).map(normName));
    for (const e of entries) {
      if (taken.has(normName(e.face))) {
        throw new FontEmbedError('already-embedded', `The presentation already embeds "${e.face}".`, e.face);
      }
    }
    const replaced =
      existing.end === existing.startTagEnd
        ? `<${q('embeddedFontLst')}>${items}</${q('embeddedFontLst')}>`
        : listXml.slice(0, listXml.lastIndexOf('</')) + items + listXml.slice(listXml.lastIndexOf('</'));
    out = xml.slice(0, existing.start) + replaced + xml.slice(existing.end);
  } else {
    const list = `<${q('embeddedFontLst')}>${items}</${q('embeddedFontLst')}>`;
    const before = new Set<string>(PRESENTATION_CHILDREN_BEFORE_FONTS.map(q));
    const after = new Set<string>(PRESENTATION_CHILDREN_AFTER_FONTS.map(q));
    let at = -1;
    for (const c of scan.children) if (before.has(c.qname)) at = c.end;
    if (at < 0) at = scan.children.find((c) => after.has(c.qname))?.start ?? scan.closeStart;
    out = xml.slice(0, at) + list + xml.slice(at);
  }
  // The root start tag precedes every insertion point: its span is still valid.
  out = setStartTagAttribute(out, scan.root, 'embedTrueTypeFonts', '1');
  if (declareRel) {
    const root = scanRoot(out).root;
    out = setStartTagAttribute(out, root, `xmlns:${relPrefix}`, NS.rel);
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function readText(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  return f ? f.async('string') : null;
}

/**
 * EXPERIMENTAL. Embed TTF / OTF fonts into a PPTX package. Returns the new package bytes.
 * Throws `FontEmbedError` (restricted / bitmap-only fonts, unsupported files, duplicates, broken packages).
 * Identical font files used for several slots are stored once.
 */
export async function embedFontsIntoPptx(
  pptx: Uint8Array,
  fonts: ReadonlyArray<EmbedFontInput>,
  options: EmbedOptions = {},
): Promise<Uint8Array> {
  const plan = planFontEmbedding(fonts, options);
  if (plan.faces.length === 0) return pptx;

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(pptx);
  } catch {
    throw new FontEmbedError('invalid-package', 'The file is not a ZIP package.');
  }
  const rootRels = await readText(zip, '_rels/.rels');
  const presPart = (rootRels && findPresentationPart(rootRels)) || 'ppt/presentation.xml';
  const presXml = await readText(zip, presPart);
  const ctXml = await readText(zip, '[Content_Types].xml');
  if (presXml === null || ctXml === null) throw new FontEmbedError('invalid-package', 'Not a PPTX package (presentation part or content types missing).');
  const relsPath = relsPathOf(presPart);
  let relsXml = (await readText(zip, relsPath)) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.pkgRels}"></Relationships>`;

  const ids = relationshipIds(relsXml);
  const fontsDir = `${dirOf(presPart)}fonts/`;
  const stored: Array<{ bytes: Uint8Array; id: string }> = [];
  const newParts: string[] = [];
  let n = 1;
  const entries: EmbeddedFontEntry[] = [];

  for (const face of plan.faces) {
    // <p:font> attributes (PANOSE, pitch & family, charset) describe the regular member when there is one.
    const representative = FONT_SLOTS.map((s) => face.slots[s]).find((f): f is PlannedFont => f !== undefined);
    if (!representative) continue;
    const entry: EmbeddedFontEntry = { face: face.face, info: representative.info, ids: {} };
    for (const slot of FONT_SLOTS) {
      const planned = face.slots[slot];
      if (!planned) continue;
      const same = stored.find((s) => sameBytes(s.bytes, planned.bytes));
      if (same) {
        entry.ids[slot] = same.id;
        continue;
      }
      while (zip.file(`${fontsDir}font${n}.fntdata`)) n++;
      const part = `${fontsDir}font${n}.fntdata`;
      zip.file(part, makeFntdata(planned.bytes, planned.info));
      newParts.push(part);
      const id = nextRelationshipId(ids);
      ids.add(id);
      relsXml = appendRelationship(relsXml, id, FONT_REL_TYPE, part.slice(dirOf(presPart).length));
      stored.push({ bytes: planned.bytes, id });
      entry.ids[slot] = id;
    }
    entries.push(entry);
  }

  zip.file(presPart, addEmbeddedFontsToPresentationXml(presXml, entries));
  zip.file(relsPath, relsXml);
  zip.file('[Content_Types].xml', registerFntdataContentType(ctXml, newParts));
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: CONFIG.fontEmbed.zipCompressionLevel },
  });
}
