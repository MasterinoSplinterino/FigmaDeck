/**
 * Intermediate representation (IR) between Figma extraction and PPTX building.
 *
 *   Figma nodes → [extract] → IR (plain JSON + binary assets) → [build] → PPTX
 *
 * Rules:
 * - Plain data only (no classes, no functions, no Figma objects). Binary data lives in `Deck.assets`
 *   as `Uint8Array`; `ir/serialize.ts` converts it to base64 for the "Export IR JSON" debug file.
 * - Units are Figma px. The builder maps 1 px → 1 pt (slide inches = px / 72) and applies the
 *   per-slide scale factor (PowerPoint's 56" limit, mixed slide sizes).
 * - Coordinates are relative to the slide's top-left corner (the exported frame).
 * - The IR keeps Figma semantics where a calibration decision belongs to the builder
 *   (raw line-height / letter-spacing units, Figma font names, text case). The extractor resolves
 *   everything that needs the Figma API (geometry, clipping, what to rasterize, image crops).
 * - `elements` arrays are in back-to-front paint order.
 */

export const IR_VERSION = 1 as const;

// ─── Deck ────────────────────────────────────────────────────────────────────

export interface Deck {
  irVersion: typeof IR_VERSION;
  meta: DeckMeta;
  slides: Slide[];
  /** Binary assets referenced by `ImageElement.assetId` / `svgAssetId`. */
  assets: Record<string, Asset>;
  /** Extraction-phase report (rasterized layers, skipped layers, warnings). */
  report: ReportEntry[];
}

export interface DeckMeta {
  title: string;
  author?: string;
  company?: string;
  subject?: string;
  /** Figma file name (informational). */
  sourceFile?: string;
  /** ISO timestamp of extraction (informational; builder never reads the clock itself). */
  createdAt?: string;
}

export type AssetMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/svg+xml';

export type AssetRole =
  /** Original bytes of a Figma IMAGE fill (photo). JPEG re-encoding allowed. */
  | 'image-fill'
  /** Flattened background ("Exact look" / "Image only"). JPEG re-encoding allowed. */
  | 'background'
  /** Rasterized layer (effects, masks, blend modes…). JPEG allowed only if opaque. */
  | 'raster'
  /** PNG fallback of a vector (icon). Always kept as PNG. */
  | 'vector-fallback'
  /** SVG version of a vector (PowerPoint 365 uses it, others use the PNG fallback). */
  | 'svg';

export interface Asset {
  id: string;
  mime: AssetMime;
  role: AssetRole;
  data: Uint8Array;
  /** Intrinsic pixel size of the bitmap (for SVG: size of the exported region in px). */
  width: number;
  height: number;
  /** Whether a raster may contain transparency. `undefined` = unknown (treat as true). */
  hasAlpha?: boolean;
  /**
   * Largest size (Figma px, uncropped) at which the asset is displayed, times nothing.
   * Lets the UI downscale oversized originals: target = display × rasterScale × maxImageOversample.
   */
  displayWidth?: number;
  displayHeight?: number;
}

// ─── Slide ───────────────────────────────────────────────────────────────────

export interface Slide {
  /** Figma node id of the frame. */
  id: string;
  name: string;
  /** Frame size in px. */
  width: number;
  height: number;
  /** Solid slide background (frame's single visible SOLID fill). `null` = none (PowerPoint shows white). */
  background: SolidFill | null;
  /** Back-to-front. */
  elements: Element[];
  /** Optional speaker notes. */
  notes?: string;
}

// ─── Geometry & paint primitives ─────────────────────────────────────────────

/** 0..1 channels (Figma convention). `a` already includes paint opacity. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Figma 2×3 affine matrix `[[a, c, tx], [b, d, ty]]` (x' = a·x + c·y + tx; y' = b·x + d·y + ty). */
export type Matrix = [[number, number, number], [number, number, number]];

/**
 * Placement of an element in slide px (PowerPoint `xfrm` semantics):
 * the UNROTATED box (x, y, w, h), then flip in the box's local space, then clockwise rotation
 * around the box center.
 */
export interface Transform {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise degrees, normalized to [0, 360). */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SolidFill {
  type: 'solid';
  color: Color;
}

export interface GradientStop {
  /** 0..1 along the Figma gradient axis. */
  position: number;
  color: Color;
}

export interface LinearGradientFill {
  type: 'linear-gradient';
  stops: GradientStop[];
  /**
   * Figma `gradientTransform`: maps the element's normalized box (0..1 × 0..1, unrotated local space)
   * into gradient space, where the gradient runs along x from 0 to 1.
   */
  gradientTransform: Matrix;
}

export type Fill = SolidFill | LinearGradientFill;

export type ArrowHead = 'none' | 'arrow' | 'triangle' | 'diamond' | 'oval';

export interface Stroke {
  /** Solid color only (gradient strokes are rasterized). */
  color: Color;
  /** px */
  weight: number;
  align: 'center' | 'inside' | 'outside';
  /** Figma `dashPattern` in px (dash, gap, dash, gap…). `null`/empty = solid. */
  dash: number[] | null;
  cap: 'none' | 'round' | 'square';
  join: 'miter' | 'bevel' | 'round';
  /** Line ends (LINE nodes only). */
  startArrow: ArrowHead;
  endArrow: ArrowHead;
}

export interface Shadow {
  type: 'outer' | 'inner';
  color: Color;
  /** px */
  offsetX: number;
  offsetY: number;
  /** Figma blur radius, px. */
  blur: number;
  /** Figma spread, px (only 0 is representable natively; the extractor rasterizes otherwise). */
  spread: number;
}

export type Hyperlink =
  | { type: 'url'; url: string }
  /** Link to another node; the builder turns it into a slide jump when the node is an exported slide. */
  | { type: 'node'; nodeId: string };

/** Fractions (0..1) of the SOURCE image cut from each side (OOXML `<a:srcRect>`). */
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// ─── Elements ────────────────────────────────────────────────────────────────

export type Element = TextElement | ShapeElement | ImageElement | GroupElement;

export interface ElementBase {
  /** Figma node id (debug / report). Synthetic ids are prefixed with `~` (e.g. `~bg:12:3`). */
  id: string;
  /** Layer name (becomes the PowerPoint object name / alt text). */
  name: string;
  transform: Transform;
  /**
   * Effective layer opacity 0..1: product of the node's opacity and all ancestor opacities that are
   * not otherwise represented (PowerPoint groups have no opacity, so it is always baked into leaves).
   * Paint/color alpha is separate (in `Color.a`); the builder multiplies both.
   */
  opacity: number;
  /** Single native shadow (outer or inner). */
  shadow?: Shadow | null;
  /** Click action on the whole element. */
  hyperlink?: Hyperlink | null;
}

export interface TextElement extends ElementBase {
  type: 'text';
  /** Figma `textAlignVertical`. */
  verticalAlign: 'top' | 'middle' | 'bottom';
  /** Figma `textAutoResize`. */
  autoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  /** One entry per Figma paragraph (text split on '\n'). Never empty. */
  paragraphs: TextParagraph[];
}

export interface TextParagraph {
  align: 'left' | 'center' | 'right' | 'justify';
  /** Figma `paragraphSpacing` (px) — space after this paragraph (builder skips it on the last one). */
  spaceAfter: number;
  /** Figma `paragraphIndent` (px) — first-line indent. */
  firstLineIndent: number;
  /** Figma list options for this paragraph. */
  list: TextList | null;
  /** Runs in order. Empty for an empty paragraph ("\n\n"). Text may contain ' ' (soft break). */
  runs: TextRun[];
  /** Style of the paragraph mark (used for empty paragraphs and `<a:endParaRPr>`). */
  endStyle: TextStyle;
}

export interface TextList {
  type: 'ordered' | 'unordered';
  /** 0-based nesting level (Figma `indentation`). */
  level: number;
}

export type FigmaLineHeight =
  | { unit: 'PIXELS'; value: number }
  | { unit: 'PERCENT'; value: number }
  | { unit: 'AUTO' };

export interface FigmaLetterSpacing {
  unit: 'PIXELS' | 'PERCENT';
  value: number;
}

export type FigmaTextCase =
  | 'ORIGINAL'
  | 'UPPER'
  | 'LOWER'
  | 'TITLE'
  | 'SMALL_CAPS'
  | 'SMALL_CAPS_FORCED';

export interface TextStyle {
  /** Figma font family, e.g. "SB Sans Display". */
  fontFamily: string;
  /** Figma font style, e.g. "Semibold Italic". Mapped to a PowerPoint face by `fonts/mapping.ts`. */
  fontStyle: string;
  /** Figma numeric weight (400, 600…). Informational. */
  fontWeight: number;
  /** px */
  fontSize: number;
  lineHeight: FigmaLineHeight;
  letterSpacing: FigmaLetterSpacing;
  /** First visible SOLID fill (alpha includes paint opacity). `null` = no visible fill (invisible text). */
  color: Color | null;
  decoration: 'none' | 'underline' | 'strikethrough';
  textCase: FigmaTextCase;
  hyperlink: Hyperlink | null;
  /** Figma OpenType SUPS/SUBS if set. */
  baseline?: 'super' | 'sub';
}

export interface TextRun extends TextStyle {
  /** Never contains '\n'. May contain ' ' (soft line break → <a:br/>). */
  text: string;
}

export type ShapeGeometry = 'rect' | 'roundRect' | 'ellipse' | 'line';

export interface ShapeElement extends ElementBase {
  type: 'shape';
  /**
   * `line`: the segment goes from the top-left to the bottom-right corner of the transform box,
   * or bottom-left → top-right when exactly one of flipH / flipV is set (PowerPoint semantics).
   * `w` or `h` may be 0 for horizontal / vertical lines. `rotation` is 0 for lines.
   */
  geometry: ShapeGeometry;
  /** px, `roundRect` only (uniform radius). */
  cornerRadius: number;
  fill: Fill | null;
  stroke: Stroke | null;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  /** Raster (PNG/JPEG/GIF) asset id. */
  assetId: string;
  /** Optional SVG asset of the same region (vectors); written as `asvg:svgBlip` next to the PNG. */
  svgAssetId?: string | null;
  /** Cropping of the source image. `null` = the whole image fills the transform box. */
  crop: Crop | null;
  /** Picture geometry (clip shape). */
  geometry: 'rect' | 'roundRect' | 'ellipse';
  /** px, `roundRect` only. */
  cornerRadius: number;
  /** Present when this picture is a rasterization of non-image content (for the report). */
  rasterized?: { reasons: RasterReason[] } | null;
}

export interface GroupElement extends ElementBase {
  type: 'group';
  /**
   * Back-to-front children. The group's `transform` is the axis-aligned union of the children's
   * bounds, rotation 0, no flips; `opacity` is always 1 (already baked into the children).
   */
  children: Element[];
}

// ─── Report ──────────────────────────────────────────────────────────────────

export type RasterReason =
  /** "Exact look" mode: all non-text content flattened into the background. */
  | 'exact-mode'
  /** "Image only" mode: whole slide is one picture. */
  | 'image-mode'
  /** VECTOR / STAR / POLYGON / icon group → SVG + PNG. */
  | 'vector'
  | 'boolean-operation'
  /** Radial / angular / diamond gradient, or native gradients disabled. */
  | 'gradient'
  | 'gradient-text'
  /** IMAGE fill with TILE / rotated or skewed CROP / rotation. */
  | 'image-fill-mode'
  | 'image-filters'
  | 'image-format'
  | 'multiple-fills'
  | 'mixed-radii'
  | 'blend-mode'
  | 'mask'
  | 'blur'
  /** Several shadows, spread ≠ 0, shadow on a group… */
  | 'effects'
  /** Per-side stroke weights, gradient/image strokes, mixed caps, stroke on text… */
  | 'stroke'
  /** Skewed or non-uniformly scaled transform, flipped text. */
  | 'transform'
  /** Content cut by a clipping frame (rounded clip, partially visible text…). */
  | 'clip'
  /** Group opacity < 1 with overlapping children (per-leaf alpha would look different). */
  | 'group-opacity'
  /** Node type without a native mapping (sticky, connector, embed, table, video…). */
  | 'unsupported-node'
  /** Paint type without a native mapping (video, pattern, noise/texture…). */
  | 'unsupported-paint'
  /** Rasterized because of a user setting (e.g. image fills = "rasterize"). */
  | 'setting'
  /** Text features without a PPTX equivalent (text on path, vertical trim, missing font…). */
  | 'text-feature';

export type ReportLevel = 'raster' | 'skipped' | 'warning' | 'info';

export interface ReportEntry {
  level: ReportLevel;
  /** Machine-readable code, e.g. 'rasterized', 'outside-clip', 'missing-font', 'slide-scaled'. */
  code: string;
  slideId: string;
  slideName: string;
  nodeId?: string;
  nodeName?: string;
  nodeType?: string;
  reasons?: RasterReason[];
  /** Human-readable English message (the UI may localize by `code`/`reasons`). */
  message: string;
}
