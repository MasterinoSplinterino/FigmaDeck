/**
 * Font fixtures for the font-embedding tests (tests/fonts/):
 * - `systemFont()` finds real TTF / OTF files on the machine (Linux / macOS / Windows paths), `null` when absent;
 * - `buildSfnt()` writes a small synthetic sfnt (head, name, OS/2, post — enough for `parseFontInfo`);
 * - `patchFsType()` / `renameFamily()` derive test variants from real fonts with minimal byte edits.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─── System fonts ────────────────────────────────────────────────────────────

const FONT_DIRS = ['/usr/share/fonts', '/usr/local/share/fonts', '/Library/Fonts', '/System/Library/Fonts', 'C:\\Windows\\Fonts'];

/** Folder of the Liberation fonts (Debian / Ubuntu `fonts-liberation` or `fonts-liberation2`). */
const LIBERATION_DIR =
  ['/usr/share/fonts/truetype/liberation', '/usr/share/fonts/truetype/liberation2', '/usr/share/fonts/liberation-sans'].find((d) =>
    existsSync(join(d, 'LiberationSans-Regular.ttf')),
  ) ?? '/usr/share/fonts/truetype/liberation';

/** Liberation Sans ships the four RIBBI members as separate TTFs on most Linux systems (metric-compatible Arial). */
export const LIBERATION_SANS = {
  regular: join(LIBERATION_DIR, 'LiberationSans-Regular.ttf'),
  bold: join(LIBERATION_DIR, 'LiberationSans-Bold.ttf'),
  italic: join(LIBERATION_DIR, 'LiberationSans-Italic.ttf'),
  boldItalic: join(LIBERATION_DIR, 'LiberationSans-BoldItalic.ttf'),
} as const;

export function hasLiberationSans(): boolean {
  return Object.values(LIBERATION_SANS).every((p) => existsSync(p));
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || !existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) walk(p, depth - 1, out);
      else out.push(p);
    } catch {
      /* unreadable entry */
    }
  }
}

/** First font file whose first 4 bytes match `signature` (sfnt version tag) and whose name matches `pattern`. */
export function systemFont(signature: 'ttf' | 'otf' | 'ttc', pattern: RegExp = /./): string | null {
  const ext = signature === 'ttc' ? /\.ttc$/i : signature === 'otf' ? /\.otf$/i : /\.ttf$/i;
  const files: string[] = [];
  for (const d of FONT_DIRS) walk(d, 4, files);
  for (const f of files) {
    if (!ext.test(f) || !pattern.test(f)) continue;
    const head = readFileSync(f).subarray(0, 4);
    const tag = String.fromCharCode(...head);
    if (signature === 'ttf' && (tag === '\u0000\u0001\u0000\u0000' || tag === 'true')) return f;
    if (signature === 'otf' && tag === 'OTTO') return f;
    if (signature === 'ttc' && tag === 'ttcf') return f;
  }
  return null;
}

export function readFont(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

// ─── Table directory access ──────────────────────────────────────────────────

export function tableRecord(font: Uint8Array, tag: string): { offset: number; length: number } {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const n = view.getUint16(4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    if (String.fromCharCode(...font.subarray(rec, rec + 4)) === tag) {
      return { offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) };
    }
  }
  throw new Error(`table ${tag} not found`);
}

/**
 * Copy of `font` with OS/2 fsType replaced. ONLY those two bytes change: the OS/2 table checksum and
 * head.checkSumAdjustment become stale on purpose — the test must show that the licence bits alone decide,
 * and neither `parseFontInfo` nor font renderers verify checksums (the variant is never installed).
 */
export function patchFsType(font: Uint8Array, fsType: number): Uint8Array {
  const out = font.slice();
  const { offset } = tableRecord(out, 'OS/2');
  new DataView(out.buffer).setUint16(offset + 8, fsType);
  return out;
}

/**
 * Copy of `font` with every occurrence of `from` in the name table replaced by `to` (same length, so no offset
 * changes): UTF-16BE (Windows / Unicode records) and single-byte (Mac Roman records). Checksums become stale
 * (see `patchFsType`). Used to make a font whose family is certainly not installed.
 */
export function renameFamily(font: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('renameFamily: names must have the same length');
  const out = font.slice();
  const { offset, length } = tableRecord(out, 'name');
  const encodings: Array<(s: string) => number[]> = [
    (s) => [...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]),
    (s) => [...s].map((c) => c.charCodeAt(0)),
  ];
  let replaced = 0;
  for (const enc of encodings) {
    const a = enc(from);
    const b = enc(to);
    for (let i = offset; i + a.length <= offset + length; i++) {
      if (a.every((v, k) => out[i + k] === v)) {
        out.set(b, i);
        replaced++;
      }
    }
  }
  if (replaced === 0) throw new Error(`renameFamily: "${from}" not found in the name table`);
  return out;
}

// ─── Synthetic sfnt ──────────────────────────────────────────────────────────

export interface NameRecordSpec {
  platform: number;
  encoding: number;
  language: number;
  nameId: number;
  text: string;
}

export interface SyntheticFontSpec {
  /** sfnt version: TrueType (0x00010000), Apple 'true' or CFF 'OTTO'. */
  flavor?: 'ttf' | 'true' | 'otf';
  /** Windows en-US names (platform 3, encoding 1, language 0x0409) by name ID. */
  names?: Record<number, string>;
  /** Additional raw name records (other platforms / languages). */
  extraNames?: NameRecordSpec[];
  os2Version?: number;
  weightClass?: number;
  widthClass?: number;
  fsType?: number;
  /** bit 0 ITALIC, bit 5 BOLD, bit 6 REGULAR */
  fsSelection?: number;
  /** head.macStyle: bit 0 bold, bit 1 italic */
  macStyle?: number;
  panose?: number[];
  unicodeRange?: [number, number, number, number];
  codePageRange?: [number, number];
  checkSumAdjustment?: number;
  fixedPitch?: boolean;
  /** Leave out the OS/2 table. */
  omitOs2?: boolean;
}

function encodeName(r: NameRecordSpec): number[] {
  if (r.platform === 1) return [...r.text].map((c) => c.charCodeAt(0) & 0xff);
  const out: number[] = [];
  for (let i = 0; i < r.text.length; i++) out.push(r.text.charCodeAt(i) >> 8, r.text.charCodeAt(i) & 0xff);
  return out;
}

function nameTable(records: NameRecordSpec[]): Uint8Array {
  const strings: number[] = [];
  const header = 6 + records.length * 12;
  const t = new Uint8Array(header + records.reduce((s, r) => s + encodeName(r).length, 0));
  const v = new DataView(t.buffer);
  v.setUint16(0, 0);
  v.setUint16(2, records.length);
  v.setUint16(4, header);
  records.forEach((r, i) => {
    const bytes = encodeName(r);
    const rec = 6 + i * 12;
    v.setUint16(rec, r.platform);
    v.setUint16(rec + 2, r.encoding);
    v.setUint16(rec + 4, r.language);
    v.setUint16(rec + 6, r.nameId);
    v.setUint16(rec + 8, bytes.length);
    v.setUint16(rec + 10, strings.length);
    strings.push(...bytes);
  });
  t.set(strings, header);
  return t;
}

const OS2_LENGTH: Record<number, number> = { 0: 78, 1: 86, 2: 96, 3: 96, 4: 96, 5: 100 };

function os2Table(s: SyntheticFontSpec): Uint8Array {
  const version = s.os2Version ?? 4;
  const t = new Uint8Array(OS2_LENGTH[version] ?? 96);
  const v = new DataView(t.buffer);
  v.setUint16(0, version);
  v.setUint16(4, s.weightClass ?? 400);
  v.setUint16(6, s.widthClass ?? 5);
  v.setUint16(8, s.fsType ?? 0);
  t.set((s.panose ?? [2, 11, 6, 4, 2, 2, 2, 2, 2, 4]).slice(0, 10), 32);
  (s.unicodeRange ?? [0x00000001, 0, 0, 0]).forEach((r, i) => v.setUint32(42 + i * 4, r >>> 0));
  t.set([0x54, 0x45, 0x53, 0x54], 58); // achVendID "TEST"
  v.setUint16(62, s.fsSelection ?? 0x40);
  if (version >= 1) (s.codePageRange ?? [0x00000001, 0]).forEach((r, i) => v.setUint32(78 + i * 4, r >>> 0));
  return t;
}

function headTable(s: SyntheticFontSpec): Uint8Array {
  const t = new Uint8Array(54);
  const v = new DataView(t.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint32(4, 0x00010000);
  v.setUint32(8, (s.checkSumAdjustment ?? 0x12345678) >>> 0);
  v.setUint32(12, 0x5f0f3cf5);
  v.setUint16(18, 1000); // unitsPerEm
  v.setUint16(44, s.macStyle ?? 0);
  return t;
}

function postTable(s: SyntheticFontSpec): Uint8Array {
  const t = new Uint8Array(32);
  const v = new DataView(t.buffer);
  v.setUint32(0, 0x00030000);
  v.setUint32(12, s.fixedPitch ? 1 : 0);
  return t;
}

function checksum(t: Uint8Array): number {
  const padded = new Uint8Array((t.length + 3) & ~3);
  padded.set(t);
  const v = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

/** Minimal sfnt with head / name / OS/2 / post (tables sorted by tag, 4-byte aligned, checksums set). */
export function buildSfnt(spec: SyntheticFontSpec = {}): Uint8Array {
  const names = { 1: 'Test Sans', 2: 'Regular', 4: 'Test Sans', 5: 'Version 1.000', 6: 'TestSans-Regular', ...(spec.names ?? {}) };
  const records: NameRecordSpec[] = [
    ...Object.entries(names).map(([id, text]) => ({ platform: 3, encoding: 1, language: 0x0409, nameId: Number(id), text })),
    ...(spec.extraNames ?? []),
  ];
  const tables: Array<[string, Uint8Array]> = [
    ['head', headTable(spec)],
    ['name', nameTable(records)],
    ['post', postTable(spec)],
  ];
  if (!spec.omitOs2) tables.push(['OS/2', os2Table(spec)]);
  tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const dirSize = 12 + tables.length * 16;
  let size = dirSize;
  const offsets = tables.map(([, t]) => {
    const o = size;
    size += (t.length + 3) & ~3;
    return o;
  });
  const font = new Uint8Array(size);
  const v = new DataView(font.buffer);
  const flavor = spec.flavor ?? 'ttf';
  if (flavor === 'ttf') v.setUint32(0, 0x00010000);
  else font.set([...(flavor === 'otf' ? 'OTTO' : 'true')].map((c) => c.charCodeAt(0)), 0);
  v.setUint16(4, tables.length);
  tables.forEach(([tag, t], i) => {
    const rec = 12 + i * 16;
    font.set([...tag].map((c) => c.charCodeAt(0)), rec);
    v.setUint32(rec + 4, checksum(t));
    v.setUint32(rec + 8, offsets[i]);
    v.setUint32(rec + 12, t.length);
    font.set(t, offsets[i]);
  });
  return font;
}
