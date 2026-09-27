/**
 * String-level access to the shape tree of a slide: split `<p:spTree>` into its top-level objects,
 * patch them one by one, join them back. Nothing is re-serialized, so namespace prefixes, attribute
 * order and unknown markup survive untouched.
 */

export interface SpTreeParts {
  /** Everything up to and including the tree's own `<p:grpSpPr>`. */
  head: string;
  /** Top-level objects (`<p:sp>`, `<p:pic>`, `<p:grpSp>`, `<p:graphicFrame>`, `<p:cxnSp>`…), in z-order. */
  objects: string[];
  /** `</p:spTree>` and everything after it. */
  tail: string;
}

/**
 * Index just past the element that starts at `start` (`<p:tag …>…</p:tag>` or `<p:tag …/>`),
 * honouring nested elements of the same name.
 */
export function elementEnd(xml: string, start: number): number {
  const open = /^<([\w]+:[\w]+|[\w]+)\b/.exec(xml.slice(start, start + 64));
  if (!open) throw new Error(`elementEnd: no element at ${start}`);
  const tag = open[1];
  const re = new RegExp(`<(/?)${tag.replace(':', '\\:')}(?=[\\s/>])[^>]*?(/?)>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const closing = m[1] === '/';
    const selfClosing = m[2] === '/';
    if (closing) depth--;
    else if (!selfClosing) depth++;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error(`elementEnd: unterminated <${tag}> at ${start}`);
}

export function splitSpTree(xml: string): SpTreeParts {
  const treeStart = xml.indexOf('<p:spTree>');
  if (treeStart < 0) throw new Error('splitSpTree: <p:spTree> not found');
  let pos = treeStart + '<p:spTree>'.length;
  // The tree's own non-visual and group properties.
  for (const tag of ['<p:nvGrpSpPr', '<p:grpSpPr']) {
    const at = xml.indexOf(tag, pos);
    if (at < 0 || xml.slice(pos, at).trim() !== '') throw new Error(`splitSpTree: ${tag}> expected`);
    pos = elementEnd(xml, at);
  }
  const head = xml.slice(0, pos);
  const objects: string[] = [];
  for (;;) {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
    if (xml.startsWith('</p:spTree>', pos)) break;
    if (xml[pos] !== '<') throw new Error(`splitSpTree: unexpected content at ${pos}`);
    const end = elementEnd(xml, pos);
    objects.push(xml.slice(pos, end));
    pos = end;
  }
  return { head, objects, tail: xml.slice(pos) };
}

export function joinSpTree(parts: SpTreeParts): string {
  return parts.head + parts.objects.join('') + parts.tail;
}

/** `name` attribute of the object's first `<p:cNvPr>` (raw, still escaped). */
export function objectName(objectXml: string): string | null {
  const m = /<p:cNvPr\b[^>]*?\bname="([^"]*)"/.exec(objectXml);
  return m ? m[1] : null;
}

/** All `<p:cNvPr id>` values in a part. */
export function drawingIds(xml: string): number[] {
  return [...xml.matchAll(/<p:cNvPr\b[^>]*?\bid="(\d+)"/g)].map((m) => Number(m[1]));
}
