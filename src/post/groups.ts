/**
 * Wrap contiguous top-level objects into `<p:grpSp>` (Figma groups / frames).
 *
 * The group transform is the identity mapping (off = chOff, ext = chExt = union of the members'
 * bounds), so members keep their slide coordinates.
 */
import type { EmuRect, ManifestGroup } from '../build/manifest';
import { CONFIG } from '../config';
import type { HyperlinkRef } from './objects';

export interface NamedObject {
  /** `fd:<n>` name (null for objects the builder did not write). */
  name: string | null;
  xml: string;
}

export function groupShapeXml(id: number, name: string, bounds: EmuRect, membersXml: string, link?: HyperlinkRef | null): string {
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  const cx = Math.min(CONFIG.ooxml.maxInt32, Math.max(1, Math.round(bounds.w)));
  const cy = Math.min(CONFIG.ooxml.maxInt32, Math.max(1, Math.round(bounds.h)));
  const hlink = link ? `<a:hlinkClick r:id="${link.rId}"${link.action ? ` action="${link.action}"` : ''}/>` : '';
  const cNvPr = hlink ? `<p:cNvPr id="${id}" name="${name}">${hlink}</p:cNvPr>` : `<p:cNvPr id="${id}" name="${name}"/>`;
  return (
    `<p:grpSp><p:nvGrpSpPr>${cNvPr}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/>` +
    `<a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></p:grpSpPr>` +
    `${membersXml}</p:grpSp>`
  );
}

export interface WrapResult {
  objects: NamedObject[];
  /** Groups that could not be wrapped (members missing or not contiguous). */
  skipped: string[];
}

/**
 * Wrap groups in the given order (nested groups first). `nextId` hands out unique `cNvPr` ids,
 * `linkOf` resolves a group's hyperlink.
 */
export function wrapGroups(
  objects: ReadonlyArray<NamedObject>,
  groups: ReadonlyArray<ManifestGroup>,
  nextId: () => number,
  linkOf: (group: ManifestGroup) => HyperlinkRef | null,
): WrapResult {
  let list = [...objects];
  const skipped: string[] = [];
  for (const g of groups) {
    const idx = g.members.map((m) => list.findIndex((o) => o.name === m));
    const first = idx[0];
    const contiguous = idx.length > 0 && idx.every((v, i) => v >= 0 && v === first + i);
    if (!contiguous) {
      skipped.push(g.name);
      continue;
    }
    const members = list.slice(first, first + idx.length);
    const xml = groupShapeXml(nextId(), g.name, g.bounds, members.map((m) => m.xml).join(''), linkOf(g));
    list = [...list.slice(0, first), { name: g.name, xml }, ...list.slice(first + idx.length)];
  }
  return { objects: list, skipped };
}
