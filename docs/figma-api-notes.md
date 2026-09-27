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

## Not verified yet (Figma MCP Starter-plan call limit reached)

* Temporary clone moved to the page root with `relativeTransform = original.absoluteTransform`
  keeps the same `absoluteRenderBounds` (expected).
* `exportAsync({contentsOnly:false})` of a node includes the backdrop underneath (expected per
  typings: "any overlapping layer in the same area") — would allow backdrop-dependent effects
  (background blur, blend modes) to be flattened with their backdrop while texts stay native.
* Whether a child's default export is clipped by an ancestor with `clipsContent`.
