/**
 * Relationship parts (`*.rels`): parse existing ids and append new relationships as text.
 */
import { escapeXml } from '../build/xml';

export const REL_TYPE = {
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
} as const;

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

const REL_TAG = /<Relationship\b[^>]*>/g;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/** Decode the five predefined XML entities and numeric character references (attribute values). */
export function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    switch (e) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

/** All relationships of a `.rels` part (attribute values unescaped). */
export function parseRelationships(xml: string): Relationship[] {
  const out: Relationship[] = [];
  for (const m of xml.matchAll(REL_TAG)) {
    const tag = m[0];
    out.push({
      id: attr(tag, 'Id') ?? '',
      type: unescapeXml(attr(tag, 'Type') ?? ''),
      target: unescapeXml(attr(tag, 'Target') ?? ''),
      external: attr(tag, 'TargetMode') === 'External',
    });
  }
  return out;
}

/** Appends relationships to a `.rels` part with fresh `rId<n>` ids (max existing + 1…). */
export class RelsEditor {
  private nextId: number;
  private readonly added: string[] = [];

  constructor(private readonly xml: string) {
    let max = 0;
    for (const m of xml.matchAll(/\bId="rId(\d+)"/g)) max = Math.max(max, Number(m[1]));
    this.nextId = max + 1;
  }

  /** Add a relationship; returns its id. `target` is unescaped (escaped here). */
  add(type: string, target: string, external = false): string {
    const id = `rId${this.nextId++}`;
    const mode = external ? ' TargetMode="External"' : '';
    this.added.push(`<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${mode}/>`);
    return id;
  }

  get changed(): boolean {
    return this.added.length > 0;
  }

  toXml(): string {
    if (this.added.length === 0) return this.xml;
    const close = this.xml.lastIndexOf('</Relationships>');
    if (close < 0) throw new Error('RelsEditor: </Relationships> not found');
    return this.xml.slice(0, close) + this.added.join('') + this.xml.slice(close);
  }
}
