/**
 * Per-slide emission context: geometry conversion (px → EMU with the slide's scale and offset),
 * object naming, hyperlink table, manifest, report and counters.
 */
import type PptxGenJS from 'pptxgenjs';
import type { Deck, Hyperlink, Rect, ReportEntry, ReportLevel, Slide, Transform } from '../ir/types';
import type { BuildOptions } from './api';
import type { FontTracker } from './fonts';
import type { SlidePlacement } from './layout';
import type { EmuRect, LinkTarget, ManifestGroup, ManifestObject, SlideManifest } from './manifest';
import { sanitizeUrl } from './xml';
import { ptToEmu } from './units';

export interface BuildStats {
  slides: number;
  texts: number;
  shapes: number;
  images: number;
  groups: number;
}

/** Deck-wide state shared by all slide contexts. */
export interface DeckState {
  deck: Deck;
  options: BuildOptions;
  fonts: FontTracker;
  report: ReportEntry[];
  stats: BuildStats;
  /** Figma frame id → 1-based slide number (for slide-jump hyperlinks). */
  slideNumbers: Map<string, number>;
  /** SVG assets referenced by pictures. */
  svgAssets: Record<string, Uint8Array>;
  /** pptxgenjs data URLs (`image/png;base64,…`) by asset id — each asset is encoded once. */
  dataUrls: Map<string, string>;
  /** Counter for `fd:<n>` names (unique across the deck). */
  nextObjectId: number;
}

/** Element box in EMU plus the xfrm attributes. */
export interface EmuTransform extends EmuRect {
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export class SlideContext {
  readonly manifest: SlideManifest;
  private readonly linkKeys = new Map<string, number>();
  private readonly byName = new Map<string, ManifestObject | ManifestGroup>();

  constructor(
    readonly state: DeckState,
    readonly slide: Slide,
    readonly slideNumber: number,
    readonly placement: SlidePlacement,
    readonly pptSlide: PptxGenJS.Slide,
  ) {
    this.manifest = { number: slideNumber, name: slide.name, objects: [], groups: [], links: [] };
  }

  get options(): BuildOptions {
    return this.state.options;
  }

  /** px → pt factor of this slide. */
  get scale(): number {
    return this.placement.scale;
  }

  /** Slide px rectangle → EMU rectangle (scale + centering offset), integers. */
  rectEmu(r: Rect): EmuRect {
    const s = this.placement.scale;
    // Non-finite IR values would end up as "NaN" in the XML; treat them as 0.
    const rx = finite(r.x);
    const ry = finite(r.y);
    const rw = Math.max(0, finite(r.w));
    const rh = Math.max(0, finite(r.h));
    const x = ptToEmu(this.placement.offsetX + rx * s);
    const y = ptToEmu(this.placement.offsetY + ry * s);
    // Round the far edges, not the sizes, so adjacent objects stay adjacent.
    const x2 = ptToEmu(this.placement.offsetX + (rx + rw) * s);
    const y2 = ptToEmu(this.placement.offsetY + (ry + rh) * s);
    return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
  }

  transformEmu(t: Transform): EmuTransform {
    return { ...this.rectEmu(t), rotation: finite(t.rotation), flipH: !!t.flipH, flipV: !!t.flipV };
  }

  /** Next unique object name `fd:<n>`. */
  nextName(): string {
    return `fd:${this.state.nextObjectId++}`;
  }

  addObject(obj: ManifestObject): void {
    this.manifest.objects.push(obj);
    this.byName.set(obj.name, obj);
  }

  addGroup(group: ManifestGroup): void {
    this.manifest.groups.push(group);
    this.byName.set(group.name, group);
  }

  /** Emitted object or group by its `fd:<n>` name. */
  lookup(name: string): ManifestObject | ManifestGroup | undefined {
    return this.byName.get(name);
  }

  /**
   * Hyperlink → index into this slide's link table (deduplicated), or null when it cannot be
   * represented (link to a node that is not an exported slide, empty URL).
   */
  linkIndex(link: Hyperlink | null | undefined, nodeId?: string, nodeName?: string): number | null {
    if (!link) return null;
    let target: LinkTarget | null = null;
    if (link.type === 'url') {
      const url = sanitizeUrl(link.url ?? '');
      if (url) target = { type: 'url', url };
    } else if (link.type === 'node') {
      const n = this.state.slideNumbers.get(link.nodeId);
      if (n !== undefined) target = { type: 'slide', slideNumber: n };
    }
    if (!target) {
      this.addReport(
        'info',
        'link-dropped',
        link.type === 'node'
          ? `Link to node ${link.nodeId} dropped: it is not one of the exported slides.`
          : 'Empty hyperlink dropped.',
        nodeId,
        nodeName,
      );
      return null;
    }
    const key = target.type === 'url' ? `u:${target.url}` : `s:${target.slideNumber}`;
    const existing = this.linkKeys.get(key);
    if (existing !== undefined) return existing;
    const index = this.manifest.links.length;
    this.manifest.links.push(target);
    this.linkKeys.set(key, index);
    return index;
  }

  addReport(level: ReportLevel, code: string, message: string, nodeId?: string, nodeName?: string, nodeType?: string): void {
    const entry: ReportEntry = { level, code, slideId: this.slide.id, slideName: this.slide.name, message };
    if (nodeId !== undefined) entry.nodeId = nodeId;
    if (nodeName !== undefined) entry.nodeName = nodeName;
    if (nodeType !== undefined) entry.nodeType = nodeType;
    this.state.report.push(entry);
  }
}

/** Axis-aligned bounds of a box rotated clockwise by `rotation` degrees around its center. */
export function rotatedBounds(r: EmuRect, rotation: number): EmuRect {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  if (sin < 1e-12) return { ...r };
  const w = r.w * cos + r.h * sin;
  const h = r.w * sin + r.h * cos;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
}

/** Union of rectangles (EMU); `null` for an empty list. */
export function unionRects(rects: ReadonlyArray<EmuRect>): EmuRect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
