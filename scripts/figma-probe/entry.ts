/**
 * Runs the real extractor inside a Figma runtime (e.g. the Figma MCP `use_figma` tool) and
 * returns a compact summary of the IR: element tree, raster reasons, text runs, asset sizes.
 * Small assets are returned as base64 so a PPTX can be built locally from real extraction.
 *
 * Build: node scripts/figma-probe/build.mjs → scripts/figma-probe/dist/probe.js
 * Use:   <probe.js contents>; return await __figmadeckProbe('<frame id>', 'editable');
 */
import { extractDeck, toDeck } from '../../src/extract/index';
import type { Element } from '../../src/ir/types';
import { bytesToBase64 } from '../../src/ir/serialize';
import { DEFAULT_SETTINGS, type ExportMode } from '../../src/shared/settings';

const r = (n: number) => Math.round(n * 100) / 100;

function summarize(e: Element): unknown {
  const t = e.transform;
  const base: Record<string, unknown> = { type: e.type, name: e.name, xywh: [r(t.x), r(t.y), r(t.w), r(t.h)], rot: r(t.rotation), op: r(e.opacity) };
  if (t.flipH || t.flipV) base.flip = [t.flipH, t.flipV];
  if (e.shadow) base.shadow = e.shadow.type;
  if (e.type === 'group') base.children = e.children.map(summarize);
  if (e.type === 'shape') Object.assign(base, { geom: e.geometry, r: r(e.cornerRadius), fill: e.fill?.type ?? null, stroke: e.stroke ? [r(e.stroke.weight), e.stroke.align] : null });
  if (e.type === 'image') Object.assign(base, { asset: e.assetId, svg: e.svgAssetId ?? null, crop: e.crop, geom: e.geometry, reasons: e.rasterized?.reasons ?? null });
  if (e.type === 'text') Object.assign(base, {
    auto: e.autoResize, valign: e.verticalAlign,
    paras: e.paragraphs.map((p) => ({ align: p.align, runs: p.runs.map((x) => ({ t: x.text, f: `${x.fontFamily}/${x.fontStyle}`, s: r(x.fontSize), lh: x.lineHeight, ls: x.letterSpacing })) })),
  });
  return base;
}

(globalThis as any).__figmadeckProbe = async (frameId: string, mode: ExportMode = 'editable', maxInlineAsset = 120000) => {
  const node = await figma.getNodeByIdAsync(frameId);
  if (!node || !('exportAsync' in node)) throw new Error('frame not found: ' + frameId);
  const t0 = Date.now();
  const result = await extractDeck([node as SceneNode], { settings: { ...DEFAULT_SETTINGS, mode } });
  const deck = toDeck({ title: 'probe' }, result);
  const slide = deck.slides[0];
  const assets = Object.values(deck.assets).map((a) => ({
    id: a.id, mime: a.mime, role: a.role, w: a.width, h: a.height, bytes: a.data.length,
    displayW: a.displayWidth, displayH: a.displayHeight, hasAlpha: a.hasAlpha,
    b64: a.data.length <= maxInlineAsset ? bytesToBase64(a.data) : undefined,
  }));
  const leftovers = figma.currentPage.children.filter((c) => c.name.indexOf('FigmaDeck') >= 0 || c.x > 90000).map((c) => c.id + ' ' + c.name);
  return {
    ms: Date.now() - t0,
    slide: { id: slide.id, name: slide.name, w: slide.width, h: slide.height, background: slide.background },
    elements: slide.elements.map(summarize),
    report: deck.report.map((x) => `${x.level}:${x.code}:${x.nodeName ?? ''}:${(x.reasons ?? []).join(',')}`),
    assets,
    leftovers,
    ir: JSON.stringify({ ...deck, assets: {} }),
  };
};
