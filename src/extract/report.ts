/**
 * Report entries for one slide (rasterized layers with reasons, skipped layers, warnings).
 * Messages are English; the UI may localize by `code` / `reasons`.
 */
import type { RasterReason, ReportEntry, ReportLevel } from '../ir/types';

const REASON_TEXT: Record<RasterReason, string> = {
  'exact-mode': '"Exact look" mode',
  'image-mode': '"Image only" mode',
  vector: 'vector shape',
  'boolean-operation': 'boolean operation',
  gradient: 'gradient fill',
  'gradient-text': 'gradient / image text fill',
  'image-fill-mode': 'image fill mode',
  'image-filters': 'image filters',
  'image-format': 'image format',
  'multiple-fills': 'several fills',
  'mixed-radii': 'different corner radii',
  'blend-mode': 'blend mode',
  mask: 'mask',
  blur: 'blur',
  effects: 'effects',
  stroke: 'stroke',
  transform: 'skew / flip',
  clip: 'clipped by a frame',
  'group-opacity': 'group opacity over overlapping layers',
  'unsupported-node': 'layer type without a PowerPoint equivalent',
  'unsupported-paint': 'paint type without a PowerPoint equivalent',
  setting: 'export setting',
  'text-feature': 'text feature without a PowerPoint equivalent',
};

export interface NodeRef {
  id: string;
  name: string;
  type: string;
}

export class SlideReport {
  /** Entries in walk order; `null` = a slot reserved at plan time and not filled (nothing happened). */
  private readonly slots: Array<ReportEntry | null> = [];

  constructor(
    readonly slideId: string,
    readonly slideName: string,
  ) {}

  /** Entries in walk (plan) order, independent of the order in which export jobs finished. */
  get entries(): ReportEntry[] {
    return this.slots.filter((e): e is ReportEntry => e !== null);
  }

  /** Reserve a position for an entry that an export job may add later. */
  reserve(): ReportSlot {
    this.slots.push(null);
    const index = this.slots.length - 1;
    return { fill: (entry) => (this.slots[index] = entry) };
  }

  entry(level: ReportLevel, code: string, message: string, node?: NodeRef, reasons?: RasterReason[]): ReportEntry {
    const entry: ReportEntry = { level, code, slideId: this.slideId, slideName: this.slideName, message };
    if (node) {
      entry.nodeId = node.id;
      entry.nodeName = node.name;
      entry.nodeType = node.type;
    }
    if (reasons && reasons.length > 0) entry.reasons = [...reasons];
    return entry;
  }

  add(level: ReportLevel, code: string, message: string, node?: NodeRef, reasons?: RasterReason[]): void {
    this.slots.push(this.entry(level, code, message, node, reasons));
  }

  rasterizedEntry(node: NodeRef, reasons: RasterReason[]): ReportEntry {
    const why = reasons.map((r) => REASON_TEXT[r] ?? r).join(', ');
    return this.entry('raster', 'rasterized', `"${node.name}" was rasterized (${why}).`, node, reasons);
  }

  rasterized(node: NodeRef, reasons: RasterReason[]): void {
    this.slots.push(this.rasterizedEntry(node, reasons));
  }

  skipped(node: NodeRef, code: string, message: string): void {
    this.add('skipped', code, message, node);
  }

  warning(code: string, message: string, node?: NodeRef): void {
    this.add('warning', code, message, node);
  }

  info(code: string, message: string, node?: NodeRef): void {
    this.add('info', code, message, node);
  }
}

export interface ReportSlot {
  fill(entry: ReportEntry): void;
}

export function nodeRef(node: { id: string; name: string; type: string }): NodeRef {
  return { id: node.id, name: node.name, type: node.type };
}
