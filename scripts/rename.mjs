// Renames the product in one go:
//   - src/config.ts   `const PRODUCT_NAME = '…'` (CONFIG.meta.productName: window title, headers,
//                     report, file metadata, fallback file name)
//   - manifest.json   "name" (the plugin's name in Figma's menus and the Community listing)
//
// Usage: node scripts/rename.mjs "New Name"
// Then rebuild (node scripts/build.mjs). Internal identifiers (package name, storage keys,
// plugin-data keys) are left alone on purpose: renaming them would lose users' saved decks.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = resolve(root, 'src/config.ts');
const MANIFEST_FILE = resolve(root, 'manifest.json');
const NAME_LINE = /^const PRODUCT_NAME = '((?:[^'\\]|\\.)*)';$/m;

const name = (process.argv[2] ?? '').trim();
if (!name || process.argv.length > 3) {
  console.error('Usage: node scripts/rename.mjs "New Name"');
  process.exit(1);
}
if (/[\r\n]/.test(name)) {
  console.error('The name must be a single line.');
  process.exit(1);
}

const config = await readFile(CONFIG_FILE, 'utf8');
const match = config.match(NAME_LINE);
if (!match) {
  console.error(`No "const PRODUCT_NAME = '…';" line in ${CONFIG_FILE}`);
  process.exit(1);
}
const literal = `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Only the top-level "name" value changes; the file keeps its formatting (menu items have names too,
// so the result is checked by parsing it again).
const manifestText = await readFile(MANIFEST_FILE, 'utf8');
const manifest = JSON.parse(manifestText);
const previous = manifest.name;
const target = `"name": ${JSON.stringify(previous)}`;
const renamed = manifestText.replace(target, () => `"name": ${JSON.stringify(name)}`);
const check = JSON.parse(renamed);
if (check.name !== name || JSON.stringify({ ...check, name: previous }) !== JSON.stringify(manifest)) {
  console.error(`Could not rename manifest.json safely (looked for ${target}).`);
  process.exit(1);
}
await writeFile(MANIFEST_FILE, renamed);
await writeFile(CONFIG_FILE, config.replace(NAME_LINE, () => `const PRODUCT_NAME = ${literal};`));

console.log(`src/config.ts  PRODUCT_NAME: ${match[1]} → ${name}`);
console.log(`manifest.json  name: ${previous} → ${name}`);
if (/figma/i.test(name)) console.warn('Warning: Figma does not accept plugin names that contain "Figma" in the Community.');
console.log('Rebuild with: node scripts/build.mjs');
