# Figma Plugin API — verified behaviour

Facts verified on a real Figma file ("Startup Summit — 2026", 4992×1536 frames) through the
Figma MCP `use_figma` runtime (read-only probes). Keep this file updated when new behaviour is
observed; the extractor relies on it.

## exportAsync regions

| Call | Region | PNG size |
|---|---|---|
| `exportAsync({format:'PNG', constraint:{type:'SCALE', value:s}})` | `absoluteRenderBounds` (text: tight glyph bounds; frames: incl. outer effects) | `ceil(w·s) × ceil(h·s)` |
| `… useAbsoluteBounds: true` | `absoluteBoundingBox` | `ceil(w·s) × ceil(h·s)` |
| `exportAsync({format:'SVG'})` | same as PNG default | `<svg width height viewBox="0 0 ceil(w) ceil(h)">` |

Examples (scale 1):
* TEXT "9 500": render bounds 539.85×161.27 → PNG 540×162; bounding box 566.07×247 → 567×247.
* FRAME card with INNER_SHADOW only: render bounds = bounding box = 728.74×845.86 → 729×846.

Consequence: place a raster at `(renderBounds.x, renderBounds.y)` with size `pngWidth / s × pngHeight / s`
(not `renderBounds.w/h`, which would stretch the bitmap by up to 1 px).

## Text

* `getStyledTextSegments([...])` accepts and returns `fontName, fontSize, fontWeight, fills,
  letterSpacing, lineHeight, textDecoration, textCase, hyperlink, listOptions, indentation,
  paragraphSpacing, paragraphIndent, openTypeFeatures` (openTypeFeatures is a map of enabled tags).
* `absoluteRenderBounds` of TEXT is the glyph box, not the layout box — text boxes must use
  `absoluteTransform` + `width/height`.
* `hasMissingFont` is `true` when the font is not available to the current Figma client (e.g. the
  MCP runtime without SB Sans); layout boxes of such texts may be computed with fallback metrics
  (a 95 px / 103 % line was reported in a 67 px high WIDTH_AND_HEIGHT box).
* Real-world values seen: `letterSpacing {unit:'PIXELS', value:-10}` on 224.6 px, `{PERCENT, -3}`;
  `lineHeight {PERCENT, 110}`; text layer opacity 0.9; trailing spaces in `characters`.

## Paints / effects seen in production files

* Cards: FRAME, `GRADIENT_LINEAR` fill (2 stops), SOLID stroke 3.25 px `INSIDE`, `cornerRadius` 81.3,
  one `INNER_SHADOW` (radius 130, spread 0, offset 0), auto layout VERTICAL, `clipsContent: false`.
  → native `roundRect` + `gradFill` + `innerShdw` + inset line; texts stay native.
  (Deck rasterized these cards including their numbers.)
* Background: RECTANGLE with IMAGE fill, `scaleMode: 'FILL'`, `imageTransform` identity,
  all `filters` 0 → original image bytes + cover crop.
* Frame blend mode on containers is `PASS_THROUGH` (treat like NORMAL).

## Clipping (verified on temporary test nodes)

* `absoluteRenderBounds` **is already clipped by ancestors with `clipsContent`**: a 200×50 child
  sticking out of a 100×100 clipping frame reports render bounds 100×50, and its default
  `exportAsync` is the clipped 100×50 bitmap.
* A visible node entirely outside its clipping ancestor has `absoluteRenderBounds === null`, and
  `exportAsync` returns a **1×1 PNG** — exactly the 157 empty 1×1 images in the Deck reference file.
  → `absoluteRenderBounds === null` ⇒ skip the node (report `outside-clip`).
* Rasters therefore need no manual crop for rectangular clips: place the PNG at the (clipped)
  render bounds with size `png / scale`. Manual geometry clipping is only needed for NATIVE
  elements (shapes, text, original image fills).
* Drop shadow (offset 4,6, radius 8) and OUTSIDE strokes grow the render bounds accordingly.

## Rotation

* `rotation = 30` (Figma, counter-clockwise on screen) → `relativeTransform [[0.866, 0.5, tx], [-0.5, 0.866, ty]]`.
  Clockwise PowerPoint angle = `atan2(m10, m00)` = −30° → normalized 330°. Export of the rotated
  node = axis-aligned render bounds (44.64×37.32 → 45×38 PNG).

## Temporary clones (verified)

* `node.clone()` of a NESTED node puts the clone on the **current page** (not in the original parent);
  the original auto-layout parent keeps its children. Instances clone to an INSTANCE on the page.
* With `clone.relativeTransform = original.absoluteTransform` the clone's bounding and render
  bounds equal the original's exactly.
* `opacity = 0` on the clone's TEXT layers gives a byte-identical PNG to removing them, and the
  auto-layout frame keeps its size (FIXED sizing). For HUG-sized auto-layout frames set
  `layoutMode = 'NONE'` (or fixed sizing) before removing children, otherwise the frame shrinks.
* `instanceClone.detachInstance()` returns a **new FRAME node with a new id**; the instance id is
  gone afterwards. Track the returned node for cleanup.
* A removed COMPONENT stays resolvable by `getNodeByIdAsync` (with `parent === null`) — check
  `node.parent`/`node.removed`, not just existence, when verifying cleanup.
* `exportAsync({contentsOnly:false})` output differs from `contentsOnly:true` for the same node
  (includes overlapping layers / backdrop). Not used: it would also capture layers above the node.

## Text runtime notes

* Figma keeps U+2028 in `characters`; `getStyledTextSegments` does not split on it.
* Inter 12 px, `lineHeight AUTO`: 5 lines → height 75 px ⇒ AUTO = **15 px = 1.25 × size**
  (not 1.2). AUTO line height is font-specific and rounded; measure it (temporary text node with
  the same font/size, two lines) when the font is available, fall back to CONFIG.text.autoLineHeight.
* A literal U+2028 inside a JS string literal is a syntax error in the plugin sandbox — bundles must
  escape it (esbuild's default ASCII charset does).
