/**
 * JSON (de)serialization of the IR for the "Export IR JSON" debug button and test fixtures.
 * Binary assets are stored as base64 strings. Environment-neutral (no Buffer, no btoa).
 */
import type { Asset, Deck } from './types';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64[i]] = i;

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_LOOKUP[clean[i]] ?? 0;
    const b = B64_LOOKUP[clean[i + 1]] ?? 0;
    const c = B64_LOOKUP[clean[i + 2]];
    const d = B64_LOOKUP[clean[i + 3]];
    const n = (a << 18) | (b << 12) | ((c ?? 0) << 6) | (d ?? 0);
    if (o < len) out[o++] = (n >> 16) & 255;
    if (c !== undefined && o < len) out[o++] = (n >> 8) & 255;
    if (d !== undefined && o < len) out[o++] = n & 255;
  }
  return out;
}

type SerializedAsset = Omit<Asset, 'data'> & { data: string };
type SerializedDeck = Omit<Deck, 'assets'> & { assets: Record<string, SerializedAsset> };

export function serializeDeck(deck: Deck, pretty = true): string {
  const assets: Record<string, SerializedAsset> = {};
  for (const [id, asset] of Object.entries(deck.assets)) {
    assets[id] = { ...asset, data: bytesToBase64(asset.data) };
  }
  const out: SerializedDeck = { ...deck, assets };
  return JSON.stringify(out, null, pretty ? 2 : 0);
}

export function deserializeDeck(json: string): Deck {
  const parsed = JSON.parse(json) as SerializedDeck;
  const assets: Record<string, Asset> = {};
  for (const [id, asset] of Object.entries(parsed.assets ?? {})) {
    assets[id] = { ...asset, data: base64ToBytes(asset.data) };
  }
  return { ...parsed, assets };
}
