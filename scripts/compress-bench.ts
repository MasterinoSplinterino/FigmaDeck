/**
 * Benchmark / visual check of src/compress on real PNGs.
 *
 *   npx tsx scripts/compress-bench.ts <dir|file.png>... [--out DIR] [--level balanced|strong|both]
 *        [--min-kb N] [--crop PX] [--upng] [--pngquant] [--write]
 *
 * Per PNG and level: original KB, lossless-optimized KB, kept KB (smallest of palette / lossless /
 * original, as the UI would keep it), % saved, colours, PSNR, SSIM (2×2-downscaled, gated), banding
 * (see src/compress/metrics.ts), time (ms) and method.
 *
 * References (same metrics): --upng adds UPNG.encode(…, 256) (undithered quantization), --pngquant
 * runs a `pngquant` binary from PATH if installed (the engine behind TinyPNG).
 *
 * With --out DIR, writes for each lossy result a 1:1 crop sheet of the most gradient-rich window:
 * top row original / ours / references over black and over white, bottom row the same with contrast
 * stretched ×4 around the window mean (reveals banding a brighter display would show). --write also
 * writes the full compressed PNGs. BENCH_VERBOSE=1 prints every palette attempt (and, for rejected
 * images, the ungated metrics plus a `.rejected.crop.png`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as UPNGModule from '@pdf-lib/upng';
import { PNG } from 'pngjs';
import { compressRgba, measureQuality, optimizeLossless, type CompressLevel } from '../src/compress';

/** The CommonJS build nests the API under `default` (once or twice depending on the loader). */
type Upng = typeof UPNGModule;
function resolveUpng(m: unknown): Upng {
  let x = m as { encode?: unknown; default?: unknown };
  while (x && typeof x.encode !== 'function' && x.default) x = x.default as typeof x;
  return x as unknown as Upng;
}
const UPNG = resolveUpng(UPNGModule);

interface Args {
  inputs: string[];
  out: string | null;
  levels: CompressLevel[];
  minKb: number;
  crop: number;
  upng: boolean;
  pngquant: boolean;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { inputs: [], out: null, levels: ['balanced'], minKb: 0, crop: 256, upng: false, pngquant: false, write: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v === '--level') {
      const l = argv[++i];
      a.levels = l === 'both' ? ['balanced', 'strong'] : [l as CompressLevel];
    } else if (v === '--min-kb') a.minKb = Number(argv[++i]);
    else if (v === '--crop') a.crop = Number(argv[++i]);
    else if (v === '--upng') a.upng = true;
    else if (v === '--pngquant') a.pngquant = true;
    else if (v === '--write') a.write = true;
    else a.inputs.push(v);
  }
  return a;
}

function listPngs(inputs: string[]): string[] {
  const files: string[] = [];
  for (const p of inputs) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) if (f.toLowerCase().endsWith('.png')) files.push(join(p, f));
    } else files.push(p);
  }
  return files;
}

function decode(buf: Uint8Array): { data: Uint8Array; width: number; height: number } {
  const png = PNG.sync.read(Buffer.from(buf.buffer, buf.byteOffset, buf.length));
  return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
}

/** Window (size×size) with the most smooth low-frequency variation of visible colour (gradients). */
function pickWindow(rgba: Uint8Array, w: number, h: number, size: number): { x: number; y: number; s: number } {
  const s = Math.min(size, w, h);
  const B = 16;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const mean = new Float64Array(bw * bh * 4);
  const vis = new Float64Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const b = ((y / B) | 0) * bw + ((x / B) | 0);
      const a = rgba[p + 3] / 255;
      mean[b * 4] += rgba[p] * a;
      mean[b * 4 + 1] += rgba[p + 1] * a;
      mean[b * 4 + 2] += rgba[p + 2] * a;
      mean[b * 4 + 3] += rgba[p + 3];
      if (rgba[p + 3] > 0) vis[b]++;
    }
  }
  const score = new Float64Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const b = by * bw + bx;
      if (vis[b] < B * B * 0.5) continue;
      let v = 0;
      for (const nb of [bx + 1 < bw ? b + 1 : -1, by + 1 < bh ? b + bw : -1]) {
        if (nb < 0) continue;
        for (let c = 0; c < 4; c++) v += Math.abs(mean[b * 4 + c] - mean[nb * 4 + c]) / (B * B);
      }
      // Reward smooth change (a few levels per block), not hard edges.
      score[b] = v > 0.5 && v < 40 ? Math.min(v, 12) : 0;
    }
  }
  const nb = Math.max(1, Math.floor(s / B));
  let best = { x: 0, y: 0, v: -1 };
  for (let by = 0; by + nb <= bh; by++) {
    for (let bx = 0; bx + nb <= bw; bx++) {
      let v = 0;
      for (let yy = 0; yy < nb; yy++) for (let xx = 0; xx < nb; xx++) v += score[(by + yy) * bw + bx + xx];
      if (v > best.v) best = { x: bx * B, y: by * B, v };
    }
  }
  return { x: Math.min(best.x, w - s), y: Math.min(best.y, h - s), s };
}

/** Crop sheet: rows [normal, contrast × gain]; per image two columns (over black, over white). */
function cropSheet(images: Uint8Array[], w: number, win: { x: number; y: number; s: number }, gain: number): PNG {
  const { x: x0, y: y0, s } = win;
  const cols = images.length * 2;
  const gap = 4;
  const W = cols * s + (cols - 1) * gap;
  const H = 2 * s + gap;
  const sheet = new PNG({ width: W, height: H });
  sheet.data.fill(128);
  const means = [0, 1].map((bg) => {
    let sum = 0;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const p = ((y0 + y) * w + x0 + x) * 4;
        const a = images[0][p + 3] / 255;
        sum += ((images[0][p] + images[0][p + 1] + images[0][p + 2]) / 3) * a + bg * 255 * (1 - a);
      }
    }
    return sum / (s * s);
  });
  images.forEach((img, k) => {
    for (let bg = 0; bg < 2; bg++) {
      const col = k * 2 + bg;
      for (let row = 0; row < 2; row++) {
        const g = row === 0 ? 1 : gain;
        const m = means[bg];
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const p = ((y0 + y) * w + x0 + x) * 4;
            const a = img[p + 3] / 255;
            const q = ((row * (s + gap) + y) * W + col * (s + gap) + x) * 4;
            for (let c = 0; c < 3; c++) {
              const v = img[p + c] * a + bg * 255 * (1 - a);
              sheet.data[q + c] = Math.max(0, Math.min(255, Math.round(m + (v - m) * g)));
            }
            sheet.data[q + 3] = 255;
          }
        }
      }
    }
  });
  return sheet;
}

interface Reference {
  name: string;
  bytes: Uint8Array;
  rgba: Uint8Array;
}

function references(file: string, data: Uint8Array, width: number, height: number, args: Args, tmp: string): Reference[] {
  const refs: Reference[] = [];
  if (args.upng) {
    const u = new Uint8Array(UPNG.encode([data.slice().buffer], width, height, 256));
    refs.push({ name: 'upng256', bytes: u, rgba: decode(u).data });
  }
  if (args.pngquant) {
    const out = join(tmp, 'pq.png');
    try {
      execFileSync('pngquant', ['--force', '--output', out, '256', file], { stdio: 'ignore' });
      const b = new Uint8Array(readFileSync(out));
      refs.push({ name: 'pngquant', bytes: b, rgba: decode(b).data });
    } catch {
      // not installed, or pngquant declined (exit 98/99): no reference column
    }
  }
  return refs;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.inputs.length === 0) {
    console.error('usage: npx tsx scripts/compress-bench.ts <dir|file.png>... [--out DIR] [--level balanced|strong|both] [--min-kb N] [--crop PX] [--upng] [--pngquant] [--write]');
    process.exit(2);
  }
  if (args.out) mkdirSync(args.out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'compress-bench-'));
  const rows: string[][] = [];
  const header = ['file', 'size', 'level', 'orig KB', 'lossless KB', 'kept KB', 'saved', 'colors', 'PSNR', 'SSIM½', 'banding', 'ms', 'lossless ms', 'method'];
  const refHeader: string[] = [];
  let totalOrig = 0;
  const totalRes: Record<string, number> = {};
  const totalRef: Record<string, number> = {};
  for (const file of listPngs(args.inputs)) {
    const buf = new Uint8Array(readFileSync(file));
    if (buf.length < args.minKb * 1024) continue;
    const { data, width, height } = decode(buf);
    totalOrig += buf.length;
    const t0 = performance.now();
    const lossless = optimizeLossless(data, width, height);
    const tLossless = performance.now() - t0;
    const refs = references(file, data, width, height, args, tmp);
    const refCells: string[] = [];
    for (const r of refs) {
      const m = measureQuality(data, width, height, r.rgba);
      if (!refHeader.includes(`${r.name} KB`)) refHeader.push(`${r.name} KB`, `${r.name} PSNR`, `${r.name} SSIM½`, `${r.name} banding`);
      refCells.push((r.bytes.length / 1024).toFixed(1), m.psnr.toFixed(2), m.ssimHalf.toFixed(4), m.banding.toFixed(2));
      totalRef[r.name] = (totalRef[r.name] ?? 0) + Math.min(r.bytes.length, buf.length);
    }
    for (const level of args.levels) {
      const t1 = performance.now();
      const res = compressRgba(data, width, height, level);
      const ms = performance.now() - t1;
      const keep = res && res.bytes.length < Math.min(buf.length, lossless.length) ? res.bytes : lossless.length < buf.length ? lossless : buf;
      totalRes[level] = (totalRes[level] ?? 0) + keep.length;
      const method = res
        ? res.lossless
          ? 'palette-exact'
          : `palette${res.bytes.length < lossless.length ? '' : ' (lossless smaller)'}`
        : `lossless (gate failed)`;
      const m = res?.metrics;
      rows.push([
        basename(file),
        `${width}×${height}`,
        level,
        (buf.length / 1024).toFixed(1),
        (lossless.length / 1024).toFixed(1),
        (keep.length / 1024).toFixed(1),
        `${(100 * (1 - keep.length / buf.length)).toFixed(1)}%`,
        res ? String(res.colors) : '-',
        res ? (res.lossless ? 'inf' : res.psnr.toFixed(2)) : '-',
        res?.ssim !== undefined ? res.ssim.toFixed(4) : '-',
        m ? m.banding.toFixed(2) : res?.lossless ? '0' : '-',
        ms.toFixed(0),
        tLossless.toFixed(0),
        method,
        ...refCells,
      ]);
      if (process.env.BENCH_VERBOSE) {
        if (res) console.error(basename(file), level, JSON.stringify(res.attempts));
        else {
          const open = compressRgba(data, width, height, level, { thresholds: { minPsnr: -Infinity, minSsim: -Infinity, maxBanding: Infinity } });
          console.error(basename(file), level, 'gate failed; ungated:', JSON.stringify(open?.attempts));
          if (args.out && open) {
            const imgs = [data, decode(open.bytes).data, ...refs.map((r) => r.rgba)];
            writeFileSync(join(args.out, `${basename(file, '.png')}.${level}.rejected.crop.png`), PNG.sync.write(cropSheet(imgs, width, pickWindow(data, width, height, args.crop), 4)));
          }
        }
      }
      if (args.out && res && !res.lossless && width * height >= 64 * 64) {
        const imgs = [data, decode(res.bytes).data, ...refs.map((r) => r.rgba)];
        writeFileSync(join(args.out, `${basename(file, '.png')}.${level}.crop.png`), PNG.sync.write(cropSheet(imgs, width, pickWindow(data, width, height, args.crop), 4)));
      }
      if (args.out && args.write && res) writeFileSync(join(args.out, `${basename(file, '.png')}.${level}.png`), res.bytes);
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  const fullHeader = [...header, ...refHeader];
  const widths = fullHeader.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]): string => '| ' + fullHeader.map((_, i) => (r[i] ?? '').padEnd(widths[i])).join(' | ') + ' |';
  console.log(line(fullHeader));
  console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  for (const r of rows) console.log(line(r));
  for (const [level, total] of Object.entries(totalRes)) {
    console.log(`TOTAL ${level}: ${(totalOrig / 1024).toFixed(1)} KB → ${(total / 1024).toFixed(1)} KB (${(100 * (1 - total / totalOrig)).toFixed(1)}% saved)`);
  }
  for (const [name, total] of Object.entries(totalRef)) {
    console.log(`TOTAL ${name} (reference): ${(totalOrig / 1024).toFixed(1)} KB → ${(total / 1024).toFixed(1)} KB (${(100 * (1 - total / totalOrig)).toFixed(1)}% saved)`);
  }
}

main();
