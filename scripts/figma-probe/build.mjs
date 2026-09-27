// Bundles scripts/figma-probe/entry.ts for pasting into a Figma Plugin API runtime (use_figma).
import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const r = await esbuild.build({
  entryPoints: [resolve(here, 'entry.ts')],
  outfile: resolve(here, 'dist/probe.js'),
  bundle: true, format: 'iife', target: 'es2017', platform: 'neutral', minify: true, charset: 'ascii', metafile: true,
});
const size = Object.values(r.metafile.outputs)[0].bytes;
console.log(`probe.js ${size} bytes`);

// Packed variant: deflate + tiny inflate loader (fits the use_figma 50 000-char limit).
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
// esbuild keeps raw UTF-8 inside regex literals even with charset ascii: escape it so the
// loader can decode bytes as Latin-1.
const text = readFileSync(resolve(here, 'dist/probe.js'), 'utf8').replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
writeFileSync(resolve(here, 'dist/probe.js'), text);
const src = Buffer.from(text, 'latin1');
const packed = deflateRawSync(src, { level: 9 }).toString('base64');
const loader = readFileSync(resolve(here, 'loader.js'), 'utf8').replace(/^\/\/.*\n/gm, '');
const out = loader.replace('__PACKED__', JSON.stringify(packed));
writeFileSync(resolve(here, 'dist/probe-packed.js'), out);
console.log(`probe-packed.js ${out.length} chars`);
