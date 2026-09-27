/**
 * Post-processing of one slide part (+ its relationships), driven by the slide manifest:
 * hyperlink relationships, per-object patches, group wrapping, empty lines, object names.
 */
import type { ManifestObject, SlideManifest } from '../build/manifest';
import { renderTextBody } from '../build/textBody';
import { escapeXml } from '../build/xml';
import { wrapGroups, type NamedObject } from './groups';
import {
  addClickHyperlink,
  addSvgBlip,
  replaceFill,
  replaceGeometry,
  replaceLn,
  replaceTxBody,
  setEffectList,
  type HyperlinkRef,
} from './objects';
import { REL_TYPE, RelsEditor, unescapeXml } from './rels';
import { drawingIds, joinSpTree, objectName, splitSpTree } from './spTree';

export const SLIDE_JUMP_ACTION = 'ppaction://hlinksldjump';

export interface SlidePatchInput {
  xml: string;
  relsXml: string;
  manifest: SlideManifest;
  /** SVG asset id → media target relative to the slide part (`../media/…svg`). */
  svgTargets: ReadonlyMap<string, string>;
}

export interface SlidePatchResult {
  xml: string;
  relsXml: string;
  warnings: string[];
}

/** Empty line properties mean "inherit from the style"; pptxgenjs shapes have no style → no line. */
export function fixEmptyLines(xml: string): string {
  return xml.replace(/<a:ln(\s[^>]*)?><\/a:ln>/g, (_, attrs: string | undefined) => `<a:ln${attrs ?? ''}><a:noFill/></a:ln>`);
}

/** Replace `fd:<n>` object names by the (escaped) layer names. */
export function renameObjects(xml: string, names: ReadonlyMap<string, string>): string {
  return xml.replace(/(<p:cNvPr\b[^>]*?\bname=")(fd:\d+)(")/g, (all, pre: string, name: string, post: string) => {
    const layer = names.get(name);
    return layer === undefined ? all : pre + escapeXml(layer) + post;
  });
}

function patchObject(
  xml: string,
  obj: ManifestObject,
  links: ReadonlyArray<HyperlinkRef>,
  svgRel: (assetId: string) => string | null,
): string {
  let out = xml;
  switch (obj.kind) {
    case 'text':
      out = replaceTxBody(out, renderTextBody(obj.body, links));
      break;
    case 'shape':
      if (obj.geometry) out = replaceGeometry(out, obj.geometry);
      if (obj.fill) out = replaceFill(out, obj.fill);
      out = replaceLn(out, obj.ln);
      break;
    case 'image': {
      if (obj.geometry) out = replaceGeometry(out, obj.geometry);
      const rId = obj.svgAssetId ? svgRel(obj.svgAssetId) : null;
      if (rId) out = addSvgBlip(out, rId);
      break;
    }
  }
  if (obj.effectLst) out = setEffectList(out, obj.effectLst);
  if (obj.link !== null && links[obj.link]) out = addClickHyperlink(out, links[obj.link]);
  return out;
}

export function patchSlide(input: SlidePatchInput): SlidePatchResult {
  const { manifest } = input;
  const warnings: string[] = [];
  const rels = new RelsEditor(input.relsXml);

  const links: HyperlinkRef[] = manifest.links.map((l) =>
    l.type === 'url'
      ? { rId: rels.add(REL_TYPE.hyperlink, l.url, true) }
      : { rId: rels.add(REL_TYPE.slide, `slide${l.slideNumber}.xml`), action: SLIDE_JUMP_ACTION },
  );
  const svgRIds = new Map<string, string>();
  const svgRel = (assetId: string): string | null => {
    let rId = svgRIds.get(assetId);
    if (rId === undefined) {
      const target = input.svgTargets.get(assetId);
      if (!target) return null;
      rId = rels.add(REL_TYPE.image, target);
      svgRIds.set(assetId, rId);
    }
    return rId;
  };

  const parts = splitSpTree(input.xml);
  const byName = new Map(manifest.objects.map((o) => [o.name, o] as const));
  const objects: NamedObject[] = parts.objects.map((xml) => {
    const raw = objectName(xml);
    const name = raw === null ? null : unescapeXml(raw);
    const obj = name ? byName.get(name) : undefined;
    return { name, xml: obj ? patchObject(xml, obj, links, svgRel) : xml };
  });

  let nextId = drawingIds(input.xml).reduce((a, b) => Math.max(a, b), 1) + 1;
  const wrapped = wrapGroups(
    objects,
    manifest.groups,
    () => nextId++,
    (g) => (g.link !== null ? links[g.link] ?? null : null),
  );
  for (const g of wrapped.skipped) warnings.push(`Group ${g} could not be preserved (members not contiguous); its layers were kept ungrouped.`);

  let xml = joinSpTree({ ...parts, objects: wrapped.objects.map((o) => o.xml) });
  xml = fixEmptyLines(xml);
  const names = new Map<string, string>();
  for (const o of manifest.objects) names.set(o.name, o.layerName);
  for (const g of manifest.groups) names.set(g.name, g.layerName);
  xml = renameObjects(xml, names);
  xml = xml.replace(/<p:cSld\b[^>]*>/, `<p:cSld name="${escapeXml(manifest.name)}">`);

  return { xml, relsXml: rels.toXml(), warnings };
}
