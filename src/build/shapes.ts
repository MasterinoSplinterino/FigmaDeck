/**
 * IR shapes → native PowerPoint shapes (rect / roundRect / ellipse / line).
 *
 * pptxgenjs creates the shape (id, name, xfrm, geometry, solid fill). post/ replaces the line properties
 * with `lnXml` (custom dashes, caps, joins, arrows in schema order), writes gradient fills and the exact
 * roundRect `adj`, and appends shadows.
 *
 * Stroke alignment: PowerPoint strokes are centered on the outline. Inside / outside strokes are emulated
 * by shrinking / growing the geometry by weight / 2 per side (center kept, corner radius ∓ weight / 2).
 * The fill then extends under half of the stroke, which is invisible for an opaque stroke; a
 * semi-transparent stroke would show it, so the fill and the stroke become two shapes.
 */
import type PptxGenJS from 'pptxgenjs';
import { CONFIG } from '../config';
import type { ArrowHead, Fill, LinearGradientFill, Matrix, Rect, ShapeElement, ShapeGeometry, Stroke, Transform } from '../ir/types';
import { alphaToTransparency, effectiveAlpha, hexColor, solidFillXml } from './color';
import { rotatedBounds, type SlideContext } from './context';
import { shadowEffectXml } from './effects';
import { convertLinearGradient, gradientFillXml } from './gradient';
import { clamp, emuArg, ptToEmu } from './units';

/** ST_LineWidth maximum (EMU). */
const LINE_WIDTH_MAX = 20116800;

const NO_LINE = '<a:ln><a:noFill/></a:ln>';

const ARROW: Record<ArrowHead, string | null> = {
  none: null,
  arrow: 'arrow',
  triangle: 'triangle',
  diamond: 'diamond',
  oval: 'oval',
};

/**
 * `<a:custDash>` for a Figma dash pattern (px). OOXML dash / space lengths are percentages of the line
 * width (1/1000 %). Odd-length patterns repeat once (SVG semantics). null = solid.
 */
export function custDashXml(dash: ReadonlyArray<number> | null | undefined, weight: number): string | null {
  if (!dash || dash.length === 0 || !(weight > 0)) return null;
  const values = dash.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  if (!values.some((v) => v > 0)) return null;
  const pattern = values.length % 2 === 1 ? [...values, ...values] : values;
  let ds = '';
  for (let i = 0; i < pattern.length; i += 2) {
    // Office stores d / sp as Int32 (hairline strokes with long dashes would overflow).
    const d = clamp(Math.round((pattern[i] / weight) * 100000), 1, CONFIG.ooxml.maxInt32);
    const sp = clamp(Math.round((pattern[i + 1] / weight) * 100000), 1, CONFIG.ooxml.maxInt32);
    ds += `<a:ds d="${d}" sp="${sp}"/>`;
  }
  return `<a:custDash>${ds}</a:custDash>`;
}

/**
 * Complete `<a:ln>` for a stroke: width (EMU), cap, fill, dash, join, arrow heads — children in schema
 * order. `scale` = slide px → pt factor, `opacity` = element opacity. Arrows only for lines.
 */
export function lnXml(stroke: Stroke | null | undefined, scale: number, opacity: number, withArrows = false): string {
  if (!stroke || !(stroke.weight > 0)) return NO_LINE;
  const w = clamp(ptToEmu(stroke.weight * scale), 0, LINE_WIDTH_MAX);
  const cap = stroke.cap === 'round' ? ' cap="rnd"' : stroke.cap === 'square' ? ' cap="sq"' : '';
  let xml = `<a:ln w="${w}"${cap}>`;
  xml += solidFillXml(stroke.color, effectiveAlpha(stroke.color, opacity));
  xml += custDashXml(stroke.dash, stroke.weight) ?? '<a:prstDash val="solid"/>';
  xml += stroke.join === 'round' ? '<a:round/>' : stroke.join === 'bevel' ? '<a:bevel/>' : `<a:miter lim="${CONFIG.pptx.miterLimit}"/>`;
  if (withArrows) {
    const head = ARROW[stroke.startArrow] ?? null;
    const tail = ARROW[stroke.endArrow] ?? null;
    if (head) xml += `<a:headEnd type="${head}"/>`;
    if (tail) xml += `<a:tailEnd type="${tail}"/>`;
  }
  return xml + '</a:ln>';
}

/** `<a:prstGeom prst="roundRect">` with `adj` = radius / shorter side (clamped to 50 000 = half the side). */
export function roundRectGeometryXml(radius: number, w: number, h: number): string {
  const minSide = Math.min(w, h);
  const adj = minSide > 0 ? clamp(Math.round((Math.max(0, radius) / minSide) * 100000), 0, 50000) : 0;
  return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
}

/**
 * Geometry for an inside / outside stroke: the box grows (outside) or shrinks (inside) by the stroke
 * weight, keeping its center; the corner radius changes by half the weight.
 */
export function strokeAlignedGeometry(
  t: Transform,
  radius: number,
  stroke: Pick<Stroke, 'weight' | 'align'> | null | undefined,
): { transform: Transform; radius: number } {
  if (!stroke || stroke.align === 'center' || !(stroke.weight > 0)) return { transform: t, radius };
  const d = stroke.align === 'inside' ? -stroke.weight : stroke.weight;
  const w = Math.max(0, t.w + d);
  const h = Math.max(0, t.h + d);
  return {
    transform: { ...t, x: t.x + (t.w - w) / 2, y: t.y + (t.h - h) / 2, w, h },
    radius: Math.max(0, radius + d / 2),
  };
}

/**
 * Re-express a Figma gradient defined on box `from` for a fill drawn on box `to` (same center / rotation
 * frame, e.g. the stroke-adjusted geometry), so the colors stay where Figma put them.
 * With u = (x' − x + u'·w') / w (and v alike): t = m00·u + m01·v + m02 = m00'·u' + m01'·v' + m02'.
 */
export function reframeGradient(fill: LinearGradientFill, from: Rect, to: Rect): LinearGradientFill {
  if (!(from.w > 0 && from.h > 0) || (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h)) return fill;
  const au = to.w / from.w;
  const av = to.h / from.h;
  const bu = (to.x - from.x) / from.w;
  const bv = (to.y - from.y) / from.h;
  const row = (m: [number, number, number]): [number, number, number] => [m[0] * au, m[1] * av, m[0] * bu + m[1] * bv + m[2]];
  const [r0, r1] = fill.gradientTransform;
  const gradientTransform: Matrix = [row(r0), row(r1)];
  return { ...fill, gradientTransform };
}

interface ShapePart {
  transform: Transform;
  radius: number;
  fill: Fill | null;
  /** Box the Figma fill is defined on (original geometry). */
  fillBox: Rect;
  stroke: Stroke | null;
  shadow: boolean;
}

const PPTX_SHAPE: Record<ShapeGeometry, PptxGenJS.SHAPE_NAME> = {
  rect: 'rect',
  roundRect: 'roundRect',
  ellipse: 'ellipse',
  line: 'line',
};

function emitPart(ctx: SlideContext, el: ShapeElement, part: ShapePart, link: number | null): string {
  const name = ctx.nextName();
  const t = part.transform;
  const box = ctx.transformEmu(t);
  const opts: PptxGenJS.ShapeProps = {
    x: emuArg(box.x),
    y: emuArg(box.y),
    w: emuArg(box.w),
    h: emuArg(box.h),
    objectName: name,
  };
  if (box.rotation) opts.rotate = box.rotation;
  if (box.flipH) opts.flipH = true;
  if (box.flipV) opts.flipV = true;

  let fillXml: string | null = null;
  if (part.fill?.type === 'solid') {
    opts.fill = { color: hexColor(part.fill.color), transparency: alphaToTransparency(effectiveAlpha(part.fill.color, el.opacity)) };
  } else if (part.fill?.type === 'linear-gradient') {
    const reframed = reframeGradient(part.fill, part.fillBox, t);
    fillXml = gradientFillXml(convertLinearGradient(reframed, t.w, t.h, el.opacity));
  }

  ctx.pptSlide.addShape(PPTX_SHAPE[el.geometry], opts);

  const isLine = el.geometry === 'line';
  ctx.addObject({
    kind: 'shape',
    name,
    layerName: el.name,
    bounds: rotatedBounds(box, box.rotation),
    link,
    effectLst: part.shadow && el.shadow ? shadowEffectXml(el.shadow, ctx.scale, el.opacity) : null,
    fill: fillXml,
    ln: lnXml(part.stroke, ctx.scale, el.opacity, isLine),
    geometry: el.geometry === 'roundRect' ? roundRectGeometryXml(part.radius, t.w, t.h) : null,
  });
  ctx.state.stats.shapes++;
  return name;
}

/** Emit a shape element; returns the object names written (1, or 2 for a split fill + stroke). */
export function emitShape(ctx: SlideContext, el: ShapeElement): string[] {
  const link = ctx.linkIndex(el.hyperlink, el.id, el.name);
  const t = el.transform;
  const radius = el.geometry === 'roundRect' ? Math.max(0, el.cornerRadius || 0) : 0;

  if (el.geometry === 'line') {
    return [emitPart(ctx, el, { transform: t, radius: 0, fill: null, fillBox: t, stroke: el.stroke, shadow: true }, link)];
  }

  const stroke = el.stroke && el.stroke.weight > 0 ? el.stroke : null;
  const adjusted = strokeAlignedGeometry(t, radius, stroke);
  const split =
    CONFIG.pptx.splitAlignedStroke &&
    !!el.fill &&
    !!stroke &&
    stroke.align !== 'center' &&
    effectiveAlpha(stroke.color, el.opacity) < 1;

  if (split) {
    return [
      emitPart(ctx, el, { transform: t, radius, fill: el.fill, fillBox: t, stroke: null, shadow: true }, link),
      emitPart(ctx, el, { transform: adjusted.transform, radius: adjusted.radius, fill: null, fillBox: t, stroke, shadow: false }, link),
    ];
  }
  return [
    emitPart(ctx, el, { transform: adjusted.transform, radius: adjusted.radius, fill: el.fill, fillBox: t, stroke, shadow: true }, link),
  ];
}
