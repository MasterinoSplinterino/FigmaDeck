// Bundles the plugin:
//   src/main.ts      → dist/code.js   (Figma sandbox: no DOM, ES2017 syntax)
//   src/ui/main.tsx  → dist/ui.html   (single file: JS + CSS inlined, no external requests)
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const minify = !watch && !process.argv.includes('--no-minify');

await mkdir(resolve(root, 'dist'), { recursive: true });

/** Modules pptxgenjs / jszip only touch in Node; never needed in the browser bundle. */
const nodeOnly = ['fs', 'https', 'http', 'path', 'os', 'stream', 'image-size', 'node:fs', 'node:https', 'node:path'];
const emptyNodeModules = {
  name: 'empty-node-modules',
  setup(build) {
    const filter = new RegExp(`^(${nodeOnly.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'empty-node' }));
    build.onLoad({ filter: /.*/, namespace: 'empty-node' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

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

async function writeUiHtml(result) {
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const template = await readFile(resolve(root, 'src/ui/index.html'), 'utf8');
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  // Function replacers: `$` sequences in the bundle must not be interpreted.
  const html = template
    .replace('<!-- INLINE_CSS -->', () => `<style>${safeCss}</style>`)
    .replace('<!-- INLINE_JS -->', () => `<script>${safeJs}</script>`);
  await writeFile(resolve(root, 'dist/ui.html'), html);
  console.log(`dist/ui.html  ${(html.length / 1024).toFixed(0)} KB`);
}

const uiOptions = {
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
  logLevel: 'info',
  loader: { '.svg': 'text' },
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), global: 'globalThis' },
  plugins: [
    emptyNodeModules,
    {
      name: 'inline-html',
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0 && result.outputFiles) await writeUiHtml(result);
        });
      },
    },
  ],
};

if (watch) {
  const mainCtx = await esbuild.context(mainOptions);
  const uiCtx = await esbuild.context(uiOptions);
  await Promise.all([mainCtx.watch(), uiCtx.watch()]);
  console.log('Watching for changes…');
} else {
  await Promise.all([esbuild.build(mainOptions), esbuild.build(uiOptions)]);
}
