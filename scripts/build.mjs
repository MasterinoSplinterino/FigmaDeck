// Bundles the plugin:
//   src/main.ts      → dist/code.js   (Figma sandbox: no DOM, ES2017 syntax)
//   src/ui/main.tsx  → dist/ui.html   (single file: JS + CSS inlined, no external requests)
//     src/ui/compress.worker.ts is bundled first (separate esbuild build) and injected into the UI
//     bundle as the string of the virtual module `figmadeck:compress-worker` (started from a blob:
//     URL at runtime, see src/ui/compress-client.ts).
//
// The UI bundle options are exported for scripts/ui-screenshots.mjs, which builds the same UI (with
// the worker) for its headless Chromium run. Building happens only when this file is run directly.
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

/** esbuild options of the UI bundle (JS + CSS in memory; `renderUiHtml` inlines them). */
export function uiBuildOptions({ minify = true, watch = false, logLevel = 'info', plugins = [], onWorker } = {}) {
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
    logLevel,
    loader: { '.svg': 'text' },
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), global: 'globalThis' },
    plugins: [emptyNodeModules, compressWorkerPlugin({ minify, onBundle: onWorker }), ...plugins],
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

  const mainOptions = {
    entryPoints: [resolve(root, 'src/main.ts')],
    outfile: resolve(root, 'dist/code.js'),
    bundle: true,
    format: 'iife',
    target: 'es2017',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    minify,
    sourcemap: watch ? 'inline' : false,
    logLevel: 'info',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  };

  let workerBytes = 0;
  const uiOptions = uiBuildOptions({
    minify,
    watch,
    onWorker: (code) => (workerBytes = code.length),
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
