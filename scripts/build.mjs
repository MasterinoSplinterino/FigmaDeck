// Bundles the plugin:
//   src/main.ts      → dist/code.js   (Figma sandbox: no DOM, ES2017 syntax)
//   src/ui/main.tsx  → dist/ui.html   (single file: JS + CSS inlined, no external requests)
//     src/ui/compress.worker.ts is bundled first (separate esbuild build) and injected into the UI
//     bundle as the string of the virtual module `figmadeck:compress-worker` (started from a blob:
//     URL at runtime, see src/ui/compress-client.ts).
//   THIRD_PARTY_NOTICES.md (repo root) + the virtual module `figmadeck:licenses` (Settings → About →
//     Open-source licenses): the license texts of every npm package bundled into dist/ui.html and
//     dist/code.js, detected from esbuild's metafile inputs under node_modules.
//
// `__APP_VERSION__` is package.json's version in both bundles. Legal comments (`/*! … */`,
// `@license`) are kept at the end of each bundle (`legalComments: 'eof'`).
//
// The UI bundle options are exported for scripts/ui-screenshots.mjs, which builds the same UI (with
// the worker) for its headless Chromium run. Building happens only when this file is run directly.
import * as esbuild from 'esbuild';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
/** Globals replaced at build time (declared in src/ui/virtual-modules.d.ts / src/main.ts). */
export const appDefines = { __APP_VERSION__: JSON.stringify(pkg.version) };

/** Modules pptxgenjs / jszip only touch in Node; never needed in the browser bundle. */
const nodeOnly = ['fs', 'https', 'http', 'path', 'os', 'stream', 'image-size', 'node:fs', 'node:https', 'node:path'];
export const emptyNodeModules = {
  name: 'empty-node-modules',
  setup(build) {
    const filter = new RegExp(`^(${nodeOnly.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'empty-node' }));
    build.onLoad({ filter: /.*/, namespace: 'empty-node' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

const WORKER_MODULE = 'figmadeck:compress-worker';

/** Bundles src/ui/compress.worker.ts into one classic-worker script. Returns its code and input files. */
export async function bundleCompressWorker({ minify = true, sourcemap = false } = {}) {
  const result = await esbuild.build({
    entryPoints: [resolve(root, 'src/ui/compress.worker.ts')],
    outfile: resolve(root, 'dist/compress.worker.js'),
    bundle: true,
    write: false,
    metafile: true,
    format: 'iife',
    target: 'es2020',
    platform: 'browser',
    minify,
    sourcemap: sourcemap ? 'inline' : false,
    legalComments: 'eof',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), global: 'globalThis' },
    plugins: [emptyNodeModules],
  });
  const code = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  if (!code) throw new Error('compress worker bundle is empty');
  const inputs = Object.keys(result.metafile.inputs).map((p) => resolve(root, p));
  return { code, inputs };
}

/**
 * `import code from 'figmadeck:compress-worker'` → the bundled worker source as a string. The worker's
 * inputs are watch files of the UI build, so `--watch` rebuilds the UI when src/compress changes.
 */
export function compressWorkerPlugin({ minify = true, sourcemap = false, onBundle } = {}) {
  return {
    name: 'compress-worker',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${WORKER_MODULE}$`) }, (args) => ({ path: args.path, namespace: 'compress-worker' }));
      build.onLoad({ filter: /.*/, namespace: 'compress-worker' }, async () => {
        const { code, inputs } = await bundleCompressWorker({ minify, sourcemap });
        onBundle?.(code);
        return { contents: `export default ${JSON.stringify(code)};`, loader: 'js', watchFiles: inputs };
      });
    },
  };
}

// ─── Third-party notices ─────────────────────────────────────────────────────

const LICENSES_MODULE = 'figmadeck:licenses';

/**
 * Prebuilt files that contain other packages (their own license covers only themselves): jszip's
 * browser entry is a browserify bundle of pako, lie, immediate and setimmediate.
 */
const EMBEDDED = { 'jszip/dist/jszip.min.js': ['pako', 'lie', 'immediate', 'setimmediate'] };
/** Dual-licensed packages: the license used, and where the other license's text starts in the file. */
const LICENSE_CHOICE = { jszip: { license: 'MIT', cut: /^GPL version 3\s*$/m } };
/** Notices outside the LICENSE file: pako is "(MIT AND Zlib)"; the zlib notice heads its zlib sources. */
const EXTRA_NOTICES = { pako: { file: 'lib/zlib/deflate.js', title: 'zlib license (lib/zlib)' } };

/** Stubs every `figmadeck:*` virtual module (the metafile scan only needs real inputs). */
const stubVirtualModules = {
  name: 'stub-virtual-modules',
  setup(build) {
    build.onResolve({ filter: /^figmadeck:/ }, (args) => ({ path: args.path, namespace: 'stub-virtual' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-virtual' }, () => ({ contents: 'export default "";', loader: 'js' }));
  },
};

/** "node_modules/a/node_modules/@s/b/x.js" → { dir: "…/node_modules/@s/b", rel: "x.js", name: "@s/b" }. */
function packageOf(input) {
  const normalized = input.replace(/\\/g, '/');
  const i = normalized.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const parts = normalized.slice(i + 'node_modules/'.length).split('/');
  const nameParts = parts[0].startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  const name = nameParts.join('/');
  return { name, dir: resolve(root, normalized.slice(0, i + 'node_modules/'.length) + name), rel: parts.slice(nameParts.length).join('/') };
}

/** Input files (relative to the repo root) of the UI (+ its worker) and main bundles. */
async function bundledInputs() {
  const scan = { bundle: true, write: false, metafile: true, logLevel: 'silent', define: { ...appDefines, global: 'globalThis' } };
  const results = await Promise.all([
    esbuild.build({ ...uiBaseOptions({ minify: false, watch: false, logLevel: 'silent' }), ...scan, plugins: [emptyNodeModules, stubVirtualModules] }),
    esbuild.build({ ...scan, entryPoints: [resolve(root, 'src/ui/compress.worker.ts')], outfile: resolve(root, 'dist/scan-worker.js'), format: 'iife', platform: 'browser', plugins: [emptyNodeModules] }),
    esbuild.build({ ...mainBuildOptions({ minify: false, watch: false }), ...scan, plugins: [stubVirtualModules] }),
  ]);
  return results.flatMap((r) => Object.keys(r.metafile.inputs));
}

function repositoryUrl(p) {
  let url = typeof p.repository === 'string' ? p.repository : p.repository?.url;
  if (!url) return p.homepage ?? '';
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url.replace(/^github:/, 'https://github.com/');
}

function leadingComment(source) {
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    // Skip a "use strict" directive and blank lines before the comment starts.
    if (lines.length === 0 && (/^\s*$/.test(line) || /^\s*(['"])use strict\1;?\s*$/.test(line))) continue;
    const m = line.match(/^\s*\/\/ ?(.*)$/);
    if (!m) break;
    lines.push(m[1]);
  }
  return lines.join('\n').trim();
}

async function packageNotice(name, dir) {
  const meta = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const files = readdirSync(dir);
  const file = files.find((f) => /^licen[cs]e(\.|$)/i.test(f)) ?? files.find((f) => /^(licen[cs]e|copying)/i.test(f));
  if (!file) throw new Error(`No license file found for ${name} (${dir}): add it to the third-party notices by hand.`);
  let text = (await readFile(join(dir, file), 'utf8')).replace(/\r\n/g, '\n').trim();
  let license = typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'see license text');
  const choice = LICENSE_CHOICE[name];
  if (choice) {
    const cut = text.search(choice.cut);
    if (cut > 0) text = text.slice(0, cut).trim();
    license = `${choice.license} (chosen from ${license})`;
  }
  const extra = EXTRA_NOTICES[name];
  if (extra && existsSync(join(dir, extra.file))) {
    const notice = leadingComment(await readFile(join(dir, extra.file), 'utf8'));
    if (notice) text += `\n\n--- ${extra.title} ---\n\n${notice}`;
  }
  return { name: meta.name ?? name, version: meta.version ?? '', license, url: repositoryUrl(meta), text };
}

/**
 * License notices of every npm package bundled into dist/ui.html and dist/code.js (plus the packages
 * embedded in prebuilt files, see EMBEDDED), sorted by name.
 */
export async function collectNotices() {
  const dirs = new Map();
  for (const input of await bundledInputs()) {
    const p = packageOf(input);
    if (!p) continue;
    dirs.set(p.dir, p.name);
    for (const dep of EMBEDDED[`${p.name}/${p.rel}`] ?? []) {
      const nested = join(p.dir, 'node_modules', dep);
      dirs.set(existsSync(nested) ? nested : resolve(root, 'node_modules', dep), dep);
    }
  }
  const notices = await Promise.all([...dirs].map(([dir, name]) => packageNotice(name, dir)));
  const unique = new Map(notices.map((n) => [`${n.name}@${n.version}`, n]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** THIRD_PARTY_NOTICES.md from `collectNotices()`. */
export function noticesMarkdown(notices) {
  const out = [
    '# Third-party notices',
    '',
    'The plugin bundles the open-source packages below into `dist/ui.html` and `dist/code.js`. The same',
    'texts are shown in the plugin under Settings → About → Open-source licenses.',
    '',
    '<!-- Generated by scripts/build.mjs from the license files in node_modules. Do not edit by hand. -->',
    '',
  ];
  for (const n of notices) {
    out.push(`## ${n.name} ${n.version}`, '', `License: ${n.license}${n.url ? `  \nSource: ${n.url}` : ''}`, '', '```text', n.text, '```', '');
  }
  return out.join('\n');
}

/** `import notices from 'figmadeck:licenses'` → `collectNotices()` of the current dependencies. */
export function licensesPlugin({ onNotices } = {}) {
  return {
    name: 'licenses',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${LICENSES_MODULE}$`) }, (args) => ({ path: args.path, namespace: 'licenses' }));
      build.onLoad({ filter: /.*/, namespace: 'licenses' }, async () => {
        const notices = await collectNotices();
        await onNotices?.(notices);
        return { contents: `export default ${JSON.stringify(notices)};`, loader: 'js', watchFiles: [resolve(root, 'package-lock.json')] };
      });
    },
  };
}

// ─── Bundles ─────────────────────────────────────────────────────────────────

function uiBaseOptions({ minify, watch, logLevel }) {
  return {
    entryPoints: [resolve(root, 'src/ui/main.tsx')],
    outdir: resolve(root, 'dist/ui-tmp'),
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'eof',
    logLevel,
    loader: { '.svg': 'text' },
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), global: 'globalThis', ...appDefines },
  };
}

/** esbuild options of the UI bundle (JS + CSS in memory; `renderUiHtml` inlines them). */
export function uiBuildOptions({ minify = true, watch = false, logLevel = 'info', plugins = [], onWorker, onNotices } = {}) {
  return {
    ...uiBaseOptions({ minify, watch, logLevel }),
    plugins: [emptyNodeModules, compressWorkerPlugin({ minify, onBundle: onWorker }), licensesPlugin({ onNotices }), ...plugins],
  };
}

/** esbuild options of the main-thread bundle (dist/code.js). */
export function mainBuildOptions({ minify = true, watch = false } = {}) {
  return {
    entryPoints: [resolve(root, 'src/main.ts')],
    outfile: resolve(root, 'dist/code.js'),
    bundle: true,
    format: 'iife',
    target: 'es2017',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    minify,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'eof',
    logLevel: 'info',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), ...appDefines },
  };
}

/** src/ui/index.html with the bundle's JS and CSS inlined. */
export async function renderUiHtml(result) {
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const template = await readFile(resolve(root, 'src/ui/index.html'), 'utf8');
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  // Function replacers: `$` sequences in the bundle must not be interpreted.
  return template.replace('<!-- INLINE_CSS -->', () => `<style>${safeCss}</style>`).replace('<!-- INLINE_JS -->', () => `<script>${safeJs}</script>`);
}

async function main() {
  const watch = process.argv.includes('--watch');
  const minify = !watch && !process.argv.includes('--no-minify');
  await mkdir(resolve(root, 'dist'), { recursive: true });

  const mainOptions = mainBuildOptions({ minify, watch });

  let workerBytes = 0;
  const uiOptions = uiBuildOptions({
    minify,
    watch,
    onWorker: (code) => (workerBytes = code.length),
    onNotices: async (notices) => {
      // Commit-ready copy at the repo root, rewritten only when it changes.
      const file = resolve(root, 'THIRD_PARTY_NOTICES.md');
      const md = noticesMarkdown(notices);
      const old = existsSync(file) ? await readFile(file, 'utf8') : '';
      if (old !== md) await writeFile(file, md);
      console.log(`THIRD_PARTY_NOTICES.md  ${notices.length} packages: ${notices.map((n) => n.name).join(', ')}`);
    },
    plugins: [
      {
        name: 'inline-html',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length > 0 || !result.outputFiles) return;
            const html = await renderUiHtml(result);
            await writeFile(resolve(root, 'dist/ui.html'), html);
            console.log(`dist/ui.html  ${(html.length / 1024).toFixed(0)} KB (compression worker ${(workerBytes / 1024).toFixed(0)} KB)`);
          });
        },
      },
    ],
  });

  if (watch) {
    const mainCtx = await esbuild.context(mainOptions);
    const uiCtx = await esbuild.context(uiOptions);
    await Promise.all([mainCtx.watch(), uiCtx.watch()]);
    console.log('Watching for changes…');
  } else {
    await Promise.all([esbuild.build(mainOptions), esbuild.build(uiOptions)]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
