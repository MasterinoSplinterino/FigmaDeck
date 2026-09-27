import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, deserializeDeck, serializeDeck } from '../../src/ir/serialize';
import { IR_VERSION } from '../../src/ir/types';

function pseudoRandomBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('base64', () => {
  it('matches Node for every length 0…300', () => {
    for (let n = 0; n <= 300; n++) {
      const bytes = pseudoRandomBytes(n, n + 1);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('round-trips', () => {
    for (const n of [0, 1, 2, 3, 4, 1000, 4097]) {
      const bytes = pseudoRandomBytes(n, 7);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('decodes Node output and ignores whitespace / line breaks', () => {
    const bytes = pseudoRandomBytes(200, 3);
    const b64 = Buffer.from(bytes).toString('base64');
    const wrapped = b64.replace(/(.{76})/g, '$1\n');
    expect(base64ToBytes(wrapped)).toEqual(bytes);
  });
});

describe('serializeDeck / deserializeDeck', () => {
  it('round-trips a fixture with binary assets', () => {
    const json = readFileSync(fileURLToPath(new URL('../fixtures/kitchen-sink.ir.json', import.meta.url)), 'utf8');
    const deck = deserializeDeck(json);
    expect(deck.irVersion).toBe(IR_VERSION);
    expect(Object.keys(deck.assets).length).toBeGreaterThan(0);
    for (const a of Object.values(deck.assets)) expect(a.data).toBeInstanceOf(Uint8Array);
    // PNG signature survived base64
    expect([...deck.assets.photo.data.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const again = deserializeDeck(serializeDeck(deck, false));
    expect(again).toEqual(deck);
  });

  it('keeps U+2028 soft breaks in run text', () => {
    const json = readFileSync(fileURLToPath(new URL('../fixtures/kitchen-sink.ir.json', import.meta.url)), 'utf8');
    expect(json).toContain('Line one' + String.fromCharCode(0x2028) + 'line two');
  });
});
