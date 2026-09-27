import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { ObjectUrlCache, isMainToUi, unwrapPluginMessage } from '../../src/ui/bridge';
import { fileNameFor, safeFileBase } from '../../src/ui/download';

describe('bridge message guards', () => {
  it('accepts known main → UI messages only', () => {
    expect(isMainToUi({ type: 'slides', slides: [] })).toBe(true);
    expect(isMainToUi({ type: 'export-slide' })).toBe(true);
    expect(isMainToUi({ type: 'ui-ready' })).toBe(false); // UI → main
    expect(isMainToUi({ type: 42 })).toBe(false);
    expect(isMainToUi(null)).toBe(false);
    expect(isMainToUi('setImmediate$0.1$1')).toBe(false);
  });

  it('unwraps event.data.pluginMessage', () => {
    expect(unwrapPluginMessage({ pluginMessage: { type: 'toast', message: 'hi' } })).toEqual({ type: 'toast', message: 'hi' });
    expect(unwrapPluginMessage({ pluginMessage: { type: 'start-export' } })).toBeNull();
    expect(unwrapPluginMessage('setImmediate$0.5$3')).toBeNull();
    expect(unwrapPluginMessage(undefined)).toBeNull();
  });
});

describe('ObjectUrlCache', () => {
  function cache() {
    const created: Blob[] = [];
    const revoked: string[] = [];
    let n = 0;
    const c = new ObjectUrlCache(
      (b) => {
        created.push(b);
        return `blob:${++n}`;
      },
      (u) => revoked.push(u),
    );
    return { c, created, revoked };
  }

  it('revokes the previous URL when an id is replaced', () => {
    const { c, created, revoked } = cache();
    expect(c.set('a', new Uint8Array([1, 2, 3]))).toBe('blob:1');
    expect(c.set('a', new Uint8Array([4]))).toBe('blob:2');
    expect(revoked).toEqual(['blob:1']);
    expect(c.get('a')).toBe('blob:2');
    expect(created[0].type).toBe('image/png');
    expect(created[0].size).toBe(3);
  });

  it('retain drops (and revokes) everything else', () => {
    const { c, revoked } = cache();
    c.set('a', new Uint8Array([1]));
    c.set('b', new Uint8Array([1]));
    c.set('c', new Uint8Array([1]));
    expect(c.retain(['b'])).toBe(true);
    expect(c.retain(['b'])).toBe(false);
    expect(revoked.sort()).toEqual(['blob:1', 'blob:3']);
    expect(c.snapshot()).toEqual({ b: 'blob:2' });
  });

  it('delete and clear revoke', () => {
    const { c, revoked } = cache();
    c.set('a', new Uint8Array([1]));
    c.set('b', new Uint8Array([1]));
    c.delete('a');
    c.delete('zz');
    c.clear();
    expect(revoked).toEqual(['blob:1', 'blob:2']);
    expect(c.snapshot()).toEqual({});
  });
});

describe('file names', () => {
  it('removes characters that file systems reject', () => {
    expect(safeFileBase('Q3: Review / Final?')).toBe('Q3 Review Final');
    expect(safeFileBase('a\u0000b\tc')).toBe('a b c');
    expect(safeFileBase('  Startup Summit - 2026  ')).toBe('Startup Summit - 2026');
    expect(safeFileBase('Презентация «Рост»')).toBe('Презентация «Рост»');
  });

  it('trims dots, limits the length, falls back when empty or reserved', () => {
    expect(safeFileBase('...deck...')).toBe('deck');
    expect(safeFileBase('x'.repeat(500))).toHaveLength(CONFIG.ui.maxFileNameLength);
    expect(safeFileBase('')).toBe(CONFIG.ui.fallbackFileName);
    expect(safeFileBase('///')).toBe(CONFIG.ui.fallbackFileName);
    expect(safeFileBase('CON')).toBe(CONFIG.ui.fallbackFileName);
    expect(safeFileBase('', 'Other')).toBe('Other');
  });

  it('adds the extension', () => {
    expect(fileNameFor('Deck', '.pptx')).toBe('Deck.pptx');
    expect(fileNameFor('', '.figmadeck.json')).toBe(`${CONFIG.ui.fallbackFileName}.figmadeck.json`);
  });
});
