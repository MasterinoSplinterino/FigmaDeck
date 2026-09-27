/**
 * Figma mocks for extract/ tests: node factories with real-looking geometry (absoluteTransform,
 * bounding / render bounds computed from the tree), a fake `FigmaEnv` (exports return real minimal
 * PNGs whose IHDR matches the exported region × scale), and a mock `figma` global.
 *
 * Mock semantics (simplified but self-consistent, following docs/figma-api-notes.md):
 * - `relativeTransform` is relative to the DIRECT parent (Figma uses the container parent for group
 *   children; the extractor only reads absolute values, so this does not matter).
 * - Natural render bounds = own box padded by `renderPad` (shadows / outside strokes); containers add
 *   their children's render bounds unless they clip; `renderBounds` overrides the natural bounds.
 * - `absoluteRenderBounds` = natural bounds CLIPPED by every ancestor with `clipsContent` (its box);
 *   `null` when clipped away entirely (as in Figma).
 * - Exports render the (clipped) render bounds — or the bounding box with `useAbsoluteBounds` — into
 *   a `ceil(w·s) × ceil(h·s)` PNG; a node without render bounds exports as a 1×1 PNG. SVG exports are
 *   `ceil(w) × ceil(h)` (width, height and viewBox).
 * - `FakeEnv.clone` puts the clone at the root of `env.currentPage` (Figma: the current page, not the
 *   original parent / page); `detachInstance` returns a new node with a new id.
 * - `rotation` in factory props follows Figma: counter-clockwise degrees about the top-left corner.
 */
import { deflateSync } from 'node:zlib';
import type { ExportRequest, FigmaEnv, ImageHandle } from '../../src/extract/figma-env';
import type { Matrix, Rect } from '../../src/ir/types';

export const MIXED = Symbol('figma.mixed');

// ─── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const pngCache = new Map<string, Uint8Array>();

/** A valid PNG of `width × height` px (all zero pixels). colorType 6 = RGBA, 2 = RGB, 3 = palette. */
export function makePng(width: number, height: number, opts: { colorType?: 2 | 3 | 6; tRNS?: boolean } = {}): Uint8Array {
  const colorType = opts.colorType ?? 6;
  const key = `${width}x${height}:${colorType}:${!!opts.tRNS}`;
  const cached = pngCache.get(key);
  if (cached) return cached;
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = new Uint8Array(height * (1 + width * channels));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (colorType === 3) parts.push(chunk('PLTE', new Uint8Array([0, 0, 0])));
  if (opts.tRNS) parts.push(chunk('tRNS', new Uint8Array([0])));
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  pngCache.set(key, out);
  return out;
}

export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
export const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ─── Geometry helpers ───────────────────────────────────────────────────────

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
    [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]],
  ];
}

function boxBounds(m: Matrix, w: number, h: number): Rect {
  const pts = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map(([x, y]) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const toFigmaRect = (r: Rect) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

/** Figma-style relative transform: translate(x, y) · rotate(ccw deg) · optional mirror. */
export function placement(x: number, y: number, rotationCcw = 0, mirror = false): Matrix {
  const r = (rotationCcw * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const m: Matrix = [
    [cos, sin, x],
    [-sin, cos, y],
  ];
  return mirror ? mul(m, [[-1, 0, 0], [0, 1, 0]]) : m;
}

// ─── Nodes ───────────────────────────────────────────────────────────────────

let nextId = 1;
export function resetIds(): void {
  nextId = 1;
}

const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'PAGE', 'DOCUMENT', 'BOOLEAN_OPERATION']);
const SELF_PAINTING_CONTAINERS = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

export type Props = Record<string, unknown> & {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Figma rotation (counter-clockwise degrees). */
  rotation?: number;
  mirror?: boolean;
  relativeTransform?: Matrix;
  children?: MockNode[];
  /** Extra render extent around the box (px) — shadows / outside strokes. */
  renderPad?: number;
  /** Explicit absoluteRenderBounds (absolute px) or null (renders nothing). */
  renderBounds?: Rect | null;
};

export class MockNode {
  [key: string]: unknown;
  id: string;
  name: string;
  type: string;
  visible = true;
  parent: MockNode | null = null;
  removed = false;
  width: number;
  height: number;
  relativeTransform: Matrix;
  children?: MockNode[];
  renderPad = 0;
  renderBoundsOverride?: Rect | null;
  pluginData: Record<string, string> = {};

  constructor(type: string, props: Props = {}) {
    const { id, name, x, y, width, height, rotation, mirror, relativeTransform, children, renderPad, renderBounds, ...rest } = props;
    this.type = type;
    this.id = id ?? `${nextId++}:1`;
    this.name = name ?? `${type.toLowerCase()} ${this.id}`;
    this.width = width ?? 100;
    this.height = height ?? 100;
    this.relativeTransform = relativeTransform ?? placement(x ?? 0, y ?? 0, rotation ?? 0, mirror ?? false);
    if (renderPad !== undefined) this.renderPad = renderPad;
    if (renderBounds !== undefined) this.renderBoundsOverride = renderBounds;
    Object.assign(this, rest);
    if (CONTAINERS.has(type)) {
      this.children = [];
      for (const c of children ?? []) this.appendChild(c);
    }
  }

  get absoluteTransform(): Matrix {
    if (!this.parent || this.parent.type === 'PAGE' || this.parent.type === 'DOCUMENT') return this.relativeTransform;
    return mul(this.parent.absoluteTransform, this.relativeTransform);
  }

  ownBox(): Rect {
    return boxBounds(this.absoluteTransform, this.width, this.height);
  }

  get absoluteBoundingBox(): { x: number; y: number; width: number; height: number } | null {
    if (this.type === 'GROUP' || this.type === 'BOOLEAN_OPERATION') {
      const u = union((this.children ?? []).map((c) => c.bbox()).filter((r): r is Rect => r !== null));
      return u ? toFigmaRect(u) : null;
    }
    return toFigmaRect(this.ownBox());
  }

  bbox(): Rect | null {
    const b = this.absoluteBoundingBox;
    return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
  }

  /** Render bounds before any ancestor clipping. */
  naturalRenderRect(): Rect | null {
    if (this.renderBoundsOverride !== undefined) return this.renderBoundsOverride;
    if (!this.visible) return null;
    const pad = this.renderPad;
    const padded = (r: Rect): Rect => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
    if (this.type === 'GROUP' || this.type === 'BOOLEAN_OPERATION') {
      const u = union((this.children ?? []).map((c) => c.naturalRenderRect()).filter((r): r is Rect => r !== null));
      return u ? padded(u) : null;
    }
    const own = padded(this.ownBox());
    if (this.children && this.children.length > 0 && SELF_PAINTING_CONTAINERS.has(this.type) && this.clipsContent !== true) {
      return union([own, ...this.children.map((c) => c.naturalRenderRect()).filter((r): r is Rect => r !== null)]);
    }
    return own;
  }

  /** `absoluteRenderBounds`: natural bounds clipped by every ancestor with `clipsContent` (null = nothing left). */
  renderRect(): Rect | null {
    let r = this.naturalRenderRect();
    for (let a = this.parent; r && a && a.type !== 'PAGE' && a.type !== 'DOCUMENT'; a = a.parent) {
      if (a.clipsContent !== true) continue;
      const clip = a.ownBox();
      const x0 = Math.max(r.x, clip.x);
      const y0 = Math.max(r.y, clip.y);
      const x1 = Math.min(r.x + r.w, clip.x + clip.w);
      const y1 = Math.min(r.y + r.h, clip.y + clip.h);
      r = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }
    return r;
  }

  get absoluteRenderBounds(): { x: number; y: number; width: number; height: number } | null {
    const r = this.renderRect();
    return r ? toFigmaRect(r) : null;
  }

  appendChild(child: MockNode): void {
    if (child.parent?.children) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    child.parent = this;
    (this.children ??= []).push(child);
  }

  insertChild(index: number, child: MockNode): void {
    this.appendChild(child);
    this.children!.splice(this.children!.length - 1, 1);
    this.children!.splice(index, 0, child);
  }

  remove(): void {
    if (this.parent?.children) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    this.parent = null;
    this.removed = true;
  }

  /** `node.clone()`: deep copy with fresh ids, parented under nothing (the caller appends it). */
  clone(): MockNode {
    const copy = this.cloneTree();
    activeEnv?.clones.push(copy);
    return copy;
  }

  cloneTree(): MockNode {
    const copy = Object.create(MockNode.prototype) as MockNode;
    for (const [k, v] of Object.entries(this)) {
      if (k === 'parent' || k === 'children') continue;
      (copy as Record<string, unknown>)[k] = v;
    }
    copy.id = `${nextId++}:clone`;
    copy.parent = null;
    copy.removed = false;
    copy.pluginData = { ...this.pluginData };
    copy.relativeTransform = this.absoluteTransform;
    if (this.children) {
      copy.children = [];
      for (const c of this.children) {
        const cc = c.cloneTree();
        cc.relativeTransform = c.relativeTransform;
        copy.appendChild(cc);
      }
    }
    copy.clonedFrom = this;
    return copy;
  }

  /** `node.exportAsync()` → the active FakeEnv (records the call). */
  exportAsync(settings: ExportRequest): Promise<Uint8Array> {
    return (activeEnv ?? new FakeEnv()).exportAsync(this as unknown as SceneNode, settings);
  }

  detachInstance(): MockNode {
    return (activeEnv ?? new FakeEnv()).detachInstance(this as unknown as InstanceNode) as unknown as MockNode;
  }

  /** PageNode.loadAsync (dynamic-page). */
  async loadAsync(): Promise<void> {
    this.loaded = true;
  }

  setPluginData(key: string, value: string): void {
    this.pluginData[key] = value;
  }

  getPluginData(key: string): string {
    return this.pluginData[key] ?? '';
  }

  findAllWithCriteria(criteria: { types?: string[]; pluginData?: { keys?: string[] } }): MockNode[] {
    const out: MockNode[] = [];
    const visit = (n: MockNode) => {
      for (const c of n.children ?? []) {
        const typeOk = !criteria.types || criteria.types.includes(c.type);
        const dataOk = !criteria.pluginData?.keys || criteria.pluginData.keys.some((k) => k in c.pluginData);
        if (typeOk && dataOk) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
}

/** Cast a mock to the Figma type the extractor expects. */
export function scene<T = SceneNode>(n: MockNode): T {
  return n as unknown as T;
}

// ─── Paints & effects ───────────────────────────────────────────────────────

export function rgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
}

export function solid(hex = '#000000', opacity = 1, extra: Record<string, unknown> = {}): Paint {
  return { type: 'SOLID', color: rgb(hex), opacity, visible: true, blendMode: 'NORMAL', ...extra } as SolidPaint;
}

export function linear(stops: Array<[number, string, number?]> = [[0, '#ff0000'], [1, '#0000ff']], opacity = 1): Paint {
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    gradientStops: stops.map(([position, hex, a]) => ({ position, color: { ...rgb(hex), a: a ?? 1 } })),
    opacity,
    visible: true,
    blendMode: 'NORMAL',
  } as GradientPaint;
}

export function radial(): Paint {
  return { ...(linear() as GradientPaint), type: 'GRADIENT_RADIAL' } as GradientPaint;
}

export function imagePaint(hash: string, scaleMode: ImagePaint['scaleMode'] = 'FILL', extra: Record<string, unknown> = {}): Paint {
  return { type: 'IMAGE', imageHash: hash, scaleMode, opacity: 1, visible: true, blendMode: 'NORMAL', ...extra } as ImagePaint;
}

export function dropShadow(extra: Record<string, unknown> = {}): Effect {
  return {
    type: 'DROP_SHADOW',
    color: { r: 0, g: 0, b: 0, a: 0.25 },
    offset: { x: 0, y: 4 },
    radius: 8,
    spread: 0,
    visible: true,
    blendMode: 'NORMAL',
    ...extra,
  } as DropShadowEffect;
}

export function innerShadow(extra: Record<string, unknown> = {}): Effect {
  return { ...(dropShadow(extra) as unknown as Record<string, unknown>), type: 'INNER_SHADOW' } as unknown as Effect;
}

export function layerBlur(radius = 4): Effect {
  return { type: 'LAYER_BLUR', blurType: 'NORMAL', radius, visible: true } as BlurEffect;
}

// ─── Node factories ─────────────────────────────────────────────────────────

const shapeDefaults = () => ({
  fills: [] as Paint[],
  strokes: [] as Paint[],
  effects: [] as Effect[],
  opacity: 1,
  blendMode: 'PASS_THROUGH',
  isMask: false,
  strokeWeight: 1,
  strokeAlign: 'INSIDE',
  strokeJoin: 'MITER',
  strokeCap: 'NONE',
  dashPattern: [] as number[],
});

export function page(props: Props = {}): MockNode {
  return new MockNode('PAGE', { name: 'Page 1', ...props });
}

export function doc(pages: MockNode[]): MockNode {
  return new MockNode('DOCUMENT', { name: 'File', children: pages });
}

/**
 * Per-side stroke weights follow `strokeWeight`, per-corner radii follow `cornerRadius`, unless given
 * (Figma keeps them in sync).
 */
function sides(props: Props): Props {
  const w = typeof props.strokeWeight === 'number' ? props.strokeWeight : 1;
  const r = typeof props.cornerRadius === 'number' ? props.cornerRadius : 0;
  return {
    strokeTopWeight: w,
    strokeRightWeight: w,
    strokeBottomWeight: w,
    strokeLeftWeight: w,
    topLeftRadius: r,
    topRightRadius: r,
    bottomRightRadius: r,
    bottomLeftRadius: r,
    ...props,
  };
}

export function frame(props: Props = {}): MockNode {
  return new MockNode('FRAME', {
    ...shapeDefaults(),
    clipsContent: true,
    cornerRadius: 0,
    layoutMode: 'NONE',
    ...sides(props),
  });
}

export function component(props: Props = {}): MockNode {
  const n = frame(props);
  n.type = 'COMPONENT';
  return n;
}

export function instance(props: Props = {}): MockNode {
  const n = frame(props);
  n.type = 'INSTANCE';
  return n;
}

export function section(props: Props = {}): MockNode {
  return new MockNode('SECTION', { fills: [], strokes: [], ...props });
}

export function group(props: Props = {}): MockNode {
  return new MockNode('GROUP', { opacity: 1, blendMode: 'PASS_THROUGH', effects: [], isMask: false, ...props });
}

export function rect(props: Props = {}): MockNode {
  return new MockNode('RECTANGLE', {
    ...shapeDefaults(),
    fills: [solid('#ff0000')],
    cornerRadius: 0,
    cornerSmoothing: 0,
    ...sides(props),
  });
}

export function ellipse(props: Props = {}): MockNode {
  return new MockNode('ELLIPSE', {
    ...shapeDefaults(),
    fills: [solid('#00ff00')],
    cornerRadius: 0,
    arcData: { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 },
    ...props,
  });
}

/** LINE: height 0; render bounds include half the stroke weight on each side (as in Figma). */
export function line(props: Props = {}): MockNode {
  const weight = typeof props.strokeWeight === 'number' ? props.strokeWeight : 2;
  return new MockNode('LINE', {
    ...shapeDefaults(),
    height: 0,
    strokes: [solid('#000000')],
    strokeWeight: weight,
    strokeAlign: 'CENTER',
    renderPad: weight / 2,
    ...props,
  });
}

export function vector(props: Props = {}): MockNode {
  return new MockNode('VECTOR', { ...shapeDefaults(), fills: [solid('#333333')], ...props });
}

export function booleanOp(props: Props = {}): MockNode {
  return new MockNode('BOOLEAN_OPERATION', { ...shapeDefaults(), fills: [solid('#333333')], ...props });
}

export function other(type: string, props: Props = {}): MockNode {
  return new MockNode(type, { opacity: 1, ...props });
}

export interface SegmentSpec {
  characters: string;
  fontName?: FontName;
  fontSize?: number;
  fontWeight?: number;
  fills?: Paint[];
  letterSpacing?: LetterSpacing;
  lineHeight?: LineHeight;
  textDecoration?: TextDecoration;
  textCase?: TextCase;
  hyperlink?: HyperlinkTarget | null;
  listOptions?: TextListOptions;
  listSpacing?: number;
  indentation?: number;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  openTypeFeatures?: Record<string, boolean>;
}

/**
 * TEXT node. Without `segments`, one segment covers all characters with the node-level style.
 * `rejectFields`: getStyledTextSegments throws when one of these fields is requested (old clients).
 */
export function text(props: Props & { characters?: string; segments?: SegmentSpec[]; rejectFields?: string[] } = {}): MockNode {
  const { segments, rejectFields, ...rest } = props;
  const characters = (props.characters as string | undefined) ?? (segments ? segments.map((s) => s.characters).join('') : 'Hello');
  const base = {
    ...shapeDefaults(),
    fills: [solid('#000000')],
    strokes: [],
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 16,
    fontWeight: 400,
    letterSpacing: { unit: 'PERCENT', value: 0 },
    lineHeight: { unit: 'AUTO' },
    textDecoration: 'NONE',
    textCase: 'ORIGINAL',
    paragraphSpacing: 0,
    listSpacing: 0,
    paragraphIndent: 0,
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'TOP',
    textAutoResize: 'NONE',
    hasMissingFont: false,
    height: 20,
    ...rest,
    characters,
  };
  const node = new MockNode('TEXT', base);
  const specs: SegmentSpec[] = segments ?? [{ characters }];
  node.getStyledTextSegments = (fields: string[]) => {
    for (const f of fields) if (rejectFields?.includes(f)) throw new Error(`Unknown field ${f}`);
    let start = 0;
    return specs.map((s) => {
      const seg: Record<string, unknown> = { characters: s.characters, start, end: start + s.characters.length };
      start += s.characters.length;
      for (const f of fields) {
        const v = (s as unknown as Record<string, unknown>)[f];
        if (v !== undefined) seg[f] = v;
        else if (f === 'listOptions') seg[f] = { type: 'NONE' };
        else if (f === 'indentation') seg[f] = 0;
        else if (f === 'hyperlink') seg[f] = null;
        else if (f === 'openTypeFeatures') seg[f] = {};
        else {
          const nodeValue = node[f];
          seg[f] = nodeValue === MIXED ? undefined : nodeValue;
        }
      }
      return seg;
    });
  };
  return node;
}

/** Build a page with the given root frames (and a document around it). */
export function onPage(...roots: MockNode[]): MockNode {
  const p = page({ children: roots });
  doc([p]);
  return p;
}

// ─── Fake environment ───────────────────────────────────────────────────────

export interface ExportCall {
  node: MockNode;
  settings: ExportRequest;
}

/** The FakeEnv that node methods (`exportAsync`, `clone`, `detachInstance`) report to. */
let activeEnv: FakeEnv | null = null;

const fontKeyOf = (f: FontName) => `${f.family}::${f.style}`;

/** Figma's bitmap size for a region side: ceil(side × scale), float noise tolerated. */
export function ceilPx(side: number, scale = 1): number {
  return Math.max(1, Math.ceil(side * scale - 1e-6));
}

export class FakeEnv implements FigmaEnv {
  constructor() {
    activeEnv = this;
  }

  readonly mixed: symbol = MIXED;
  readonly exports: ExportCall[] = [];
  readonly clones: MockNode[] = [];
  readonly detached: MockNode[] = [];
  /** TEXT nodes made by `createText` (AUTO line-height measurement). */
  readonly createdTexts: MockNode[] = [];
  readonly images = new Map<string, { bytes: Uint8Array; width: number; height: number }>();
  /** Page where clones land (Figma: `figma.currentPage`). A scratch page unless a test sets one. */
  currentPage: MockNode = new MockNode('PAGE', { id: 'current-page', name: 'Current page' });
  /** Fonts `loadFontAsync` rejects ("family::style"). */
  readonly missingFonts = new Set<string>();
  /** Every `loadFontAsync` call. */
  readonly fontLoads: FontName[] = [];
  readonly loadedFonts = new Set<string>();
  /**
   * Natural line height / font size per family; AUTO = round(size × ratio) as in Figma
   * (Inter: (ascender 2728 + descender 680) / 2816 upm ≈ 1.2102 → 60 → 73, 13 → 16, 12 → 15).
   */
  readonly lineHeightRatio: Record<string, number> = { Inter: 1.2102 };
  yields = 0;
  /** Throw from exportAsync for these nodes (by name) or when the predicate matches. */
  failExport: (node: MockNode, settings: ExportRequest) => boolean = () => false;
  /** Called on every export (e.g. to cancel mid-way). */
  onExport: (node: MockNode) => void = () => undefined;
  /** Return a bitmap of this size instead of the region × scale (simulates Figma trimming). */
  forceSize: (node: MockNode, settings: ExportRequest) => { w: number; h: number } | null = () => null;
  /** Snapshot of each exported (clone) node tree at export time. */
  readonly exportedTrees: MockNode[] = [];

  async exportAsync(node: SceneNode, settings: ExportRequest): Promise<Uint8Array> {
    const n = node as unknown as MockNode;
    this.exports.push({ node: n, settings });
    this.exportedTrees.push(n);
    this.onExport(n);
    if (this.failExport(n, settings)) throw new Error(`export failed: ${n.name}`);
    const useAbs = 'useAbsoluteBounds' in settings && settings.useAbsoluteBounds === true;
    const region = useAbs ? n.bbox() : n.renderRect();
    if (settings.format === 'PDF') return ascii('%PDF-1.4 fake');
    // Figma: a node clipped away entirely (render bounds null) exports as a 1×1 PNG.
    if (!region) return settings.format === 'SVG' ? ascii('<svg width="1" height="1" viewBox="0 0 1 1"></svg>') : makePng(1, 1);
    if (settings.format === 'SVG') {
      const w = ceilPx(region.w);
      const h = ceilPx(region.h);
      return ascii(`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg"><rect/></svg>`);
    }
    const c = (settings as ExportSettingsImage).constraint;
    const forced = this.forceSize(n, settings);
    if (forced) return makePng(forced.w, forced.h);
    if (c?.type === 'WIDTH') return makePng(Math.round(c.value), ceilPx(region.h, c.value / region.w));
    if (c?.type === 'HEIGHT') return makePng(ceilPx(region.w, c.value / region.h), Math.round(c.value));
    const scale = c?.type === 'SCALE' ? c.value : 1;
    return makePng(ceilPx(region.w, scale), ceilPx(region.h, scale));
  }

  getImageByHash(hash: string): ImageHandle | null {
    const img = this.images.get(hash);
    if (!img) return null;
    return {
      getBytesAsync: async () => img.bytes,
      getSizeAsync: async () => ({ width: img.width, height: img.height }),
    };
  }

  /** Figma: the clone of a nested node lands at the root of the CURRENT page. */
  clone(node: SceneNode): SceneNode {
    const c = (node as unknown as MockNode).cloneTree();
    this.clones.push(c);
    this.currentPage.appendChild(c);
    return c as unknown as SceneNode;
  }

  /** Children removed from a parent that still had auto layout on (the parent would reflow in Figma). */
  readonly autoLayoutRemovals: MockNode[] = [];

  remove(node: SceneNode): void {
    const n = node as unknown as MockNode;
    const layout = n.parent?.layoutMode;
    if (typeof layout === 'string' && layout !== 'NONE') this.autoLayoutRemovals.push(n);
    n.remove();
  }

  detachInstance(node: InstanceNode): FrameNode {
    const n = node as unknown as MockNode;
    const parent = n.parent;
    const index = parent?.children?.indexOf(n) ?? -1;
    const detached = n.cloneTree();
    // Keep the provenance of the detached subtree pointing at the clone's sources.
    const relink = (d: MockNode, src: MockNode) => {
      d.clonedFrom = src.clonedFrom ?? src;
      (d.children ?? []).forEach((c, i) => relink(c, src.children![i]));
    };
    relink(detached, n);
    detached.type = 'FRAME';
    detached.relativeTransform = n.relativeTransform;
    detached.id = `${n.id}:detached`;
    if (parent && index >= 0) {
      n.remove();
      parent.insertChild(index, detached);
    } else n.removed = true;
    this.detached.push(detached);
    return detached as unknown as FrameNode;
  }

  async loadFontAsync(font: FontName): Promise<void> {
    this.fontLoads.push({ ...font });
    if (this.missingFonts.has(fontKeyOf(font))) throw new Error(`Font ${font.family} ${font.style} is not available`);
    this.loadedFonts.add(fontKeyOf(font));
  }

  /**
   * `figma.createText()`: an empty TEXT on the current page (default font Inter Regular). Like Figma,
   * setting `fontName` needs that font loaded and setting `characters` needs the CURRENT font loaded.
   * `height` follows the line height: AUTO = round(size × natural ratio) per line.
   */
  createText(): TextNode {
    const env = this;
    const node = new MockNode('TEXT', { name: 'Text', fontSize: 12, lineHeight: { unit: 'AUTO' }, textAutoResize: 'NONE', fills: [solid()] });
    let font: FontName = { family: 'Inter', style: 'Regular' };
    let chars = '';
    Object.defineProperty(node, 'fontName', {
      configurable: true,
      enumerable: true,
      get: () => font,
      set: (f: FontName) => {
        if (!env.loadedFonts.has(fontKeyOf(f))) throw new Error(`unloaded font ${f.family} ${f.style}`);
        font = { ...f };
      },
    });
    Object.defineProperty(node, 'characters', {
      configurable: true,
      enumerable: true,
      get: () => chars,
      set: (v: string) => {
        if (!env.loadedFonts.has(fontKeyOf(font))) throw new Error(`unloaded font ${font.family} ${font.style}`);
        chars = v;
      },
    });
    Object.defineProperty(node, 'height', {
      configurable: true,
      enumerable: true,
      get: () => {
        if (chars.length === 0) return 0;
        const size = node.fontSize as number;
        const lh = node.lineHeight as LineHeight;
        const line =
          lh.unit === 'PIXELS' ? lh.value : lh.unit === 'PERCENT' ? (size * lh.value) / 100 : Math.round(size * (env.lineHeightRatio[font.family] ?? 1.2));
        return line * chars.split('\n').length;
      },
      set: () => undefined,
    });
    this.currentPage.appendChild(node);
    this.createdTexts.push(node);
    return node as unknown as TextNode;
  }

  async yieldToEventLoop(): Promise<void> {
    this.yields++;
  }

  addImage(hash: string, bytes: Uint8Array, width: number, height: number): void {
    this.images.set(hash, { bytes, width, height });
  }

  /**
   * Temporary nodes (clones, detached instances, measurement texts) still in the document — should be
   * empty after every extraction. Removed = `removed` or parentless (a removed COMPONENT stays
   * resolvable with `parent === null` in Figma).
   */
  liveClones(): MockNode[] {
    const attached = (n: MockNode): boolean => {
      let x: MockNode | null = n;
      for (; x; x = x.parent) {
        if (x.removed) return false;
        if (x.type === 'PAGE') return true;
      }
      return false;
    };
    return [...this.clones, ...this.detached, ...this.createdTexts].filter(attached);
  }
}

export interface FigmaGlobalMock {
  /** Messages posted to the UI. */
  posted: Array<Record<string, unknown> & { type: string }>;
  notifications: Array<{ message: string; error?: boolean }>;
  storage: Map<string, unknown>;
  handlers: Map<string, Array<() => void>>;
  resized: Array<[number, number]>;
  zoomedTo: MockNode[][];
  api: Record<string, unknown>;
  /** Deliver a UI → main message (as `parent.postMessage({ pluginMessage })` would). */
  send(msg: Record<string, unknown>): void;
  /** Wait until a posted message matches (or throw after `timeoutMs`). */
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/**
 * Mock `figma` global: document with pages, plugin data, client storage, UI channel, events,
 * `getNodeByIdAsync`, `setCurrentPageAsync`, viewport, notify, fonts. Node side effects go to `env`.
 */
export function installFigmaGlobal(
  env: FakeEnv,
  document: MockNode = doc([page()]),
  opts: { fonts?: FontName[] } = {},
): FigmaGlobalMock {
  const posted: FigmaGlobalMock['posted'] = [];
  const handlers = new Map<string, Array<() => void>>();
  const storage = new Map<string, unknown>();
  const mock: FigmaGlobalMock = {
    posted,
    notifications: [],
    storage,
    handlers,
    resized: [],
    zoomedTo: [],
    api: {},
    send(msg) {
      const ui = mock.api.ui as { onmessage?: (m: unknown, props: unknown) => void };
      ui.onmessage?.(msg, { origin: '*' });
    },
    async waitFor(type, timeoutMs = 2000) {
      const start = Date.now();
      for (;;) {
        const found = posted.find((m) => m.type === type);
        if (found) return found;
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for "${type}"; got ${posted.map((m) => m.type).join(', ')}`);
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
  const findById = (n: MockNode, id: string): MockNode | null => {
    if (n.id === id) return n;
    for (const c of n.children ?? []) {
      const f = findById(c, id);
      if (f) return f;
    }
    return null;
  };
  const pages = document.children ?? [];
  let currentPage = pages[0];
  for (const p of pages) p.selection ??= [];
  mock.api = {
    mixed: MIXED,
    root: document,
    get currentPage() {
      return currentPage;
    },
    async setCurrentPageAsync(p: MockNode) {
      currentPage = p;
      handlers.get('currentpagechange')?.forEach((h) => h());
    },
    async getNodeByIdAsync(id: string) {
      return findById(document, id);
    },
    getImageByHash: (hash: string) => env.getImageByHash(hash),
    loadFontAsync: (font: FontName) => env.loadFontAsync(font),
    createText: () => env.createText(),
    showUI: () => undefined,
    ui: {
      onmessage: undefined,
      postMessage: (m: Record<string, unknown> & { type: string }) => posted.push(m),
      resize: (w: number, h: number) => mock.resized.push([w, h]),
    },
    on: (type: string, cb: () => void) => handlers.set(type, [...(handlers.get(type) ?? []), cb]),
    clientStorage: {
      getAsync: async (k: string) => storage.get(k),
      setAsync: async (k: string, v: unknown) => void storage.set(k, v),
    },
    viewport: { scrollAndZoomIntoView: (nodes: MockNode[]) => mock.zoomedTo.push(nodes) },
    notify: (message: string, o?: { error?: boolean }) => mock.notifications.push({ message, error: o?.error }),
    listAvailableFontsAsync: async () => (opts.fonts ?? [{ family: 'Inter', style: 'Regular' }]).map((fontName) => ({ fontName })),
  };
  (globalThis as Record<string, unknown>).figma = mock.api;
  (globalThis as Record<string, unknown>).__html__ = '<html></html>';
  return mock;
}
