/**
 * The builder must also run in the plugin UI (a browser, no Node built-ins). Bundles src/build with
 * esbuild the way scripts/build.mjs does (pptxgenjs' Node-only imports stubbed), runs it in headless
 * Chromium and checks the file is byte-identical to the Node build. Skipped when no Chromium is found.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPptx } from '../../src/build';
import { bytesToBase64 } from '../../src/ir/serialize';
import { fixturePath, loadFixture, testOptions } from '../fixtures/load';
import { openPptx, validatePackage } from '../helpers/ooxml';

function findChromium(): string | null {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter((r): r is string => !!r && existsSync(r));
  for (const root of roots) {
    for (const dir of readdirSync(root)) {
      for (const rel of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
        const bin = join(root, dir, rel);
        if (existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

const CHROMIUM = findChromium();
const NODE_ONLY = ['fs', 'https', 'http', 'path', 'os', 'stream', 'image-size', 'node:fs', 'node:https', 'node:path'];

async function bundle(): Promise<string> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const filter = new RegExp(`^(${NODE_ONLY.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
  const result = await esbuild.build({
    stdin: {
      contents:
        "export { buildPptx } from './src/build';\nexport { deserializeDeck, bytesToBase64 } from './src/ir/serialize';\n",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'FD',
    platform: 'browser',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'empty-node-modules',
        setup(build) {
          build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'empty-node' }));
          build.onLoad({ filter: /.*/, namespace: 'empty-node' }, () => ({ contents: 'export default {};', loader: 'js' }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

describe.skipIf(!CHROMIUM)('builder in a browser (headless Chromium)', () => {
  let browser: Browser;
  let script = '';

  beforeAll(async () => {
    script = await bundle();
    browser = await chromium.launch({ executablePath: CHROMIUM! });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each(['kitchen-sink', 'diploma'])('%s: same bytes as the Node build', async (name) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    const { readFileSync } = await import('node:fs');
    const json = readFileSync(fixturePath(name), 'utf8');
    const options = testOptions();
    const b64 = await page.evaluate(
      async ({ json, opts, now }) => {
        type FD = {
          buildPptx: typeof buildPptx;
          deserializeDeck: (j: string) => Parameters<typeof buildPptx>[0];
          bytesToBase64: typeof bytesToBase64;
        };
        const fd = (globalThis as unknown as { FD: FD }).FD;
        const res = await fd.buildPptx(fd.deserializeDeck(json), { ...opts, now: new Date(now) });
        return fd.bytesToBase64(res.data);
      },
      { json, opts: { ...options, now: undefined }, now: options.now!.toISOString() },
    );
    await page.close();
    expect(errors).toEqual([]);
    const fromBrowser = new Uint8Array(Buffer.from(b64, 'base64'));
    expect(validatePackage(await openPptx(fromBrowser))).toEqual([]);
    const fromNode = await buildPptx(loadFixture(name), options);
    expect(Buffer.from(fromBrowser).equals(Buffer.from(fromNode.data))).toBe(true);
  }, 120000);
});
