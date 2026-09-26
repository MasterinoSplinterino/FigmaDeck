# FigmaDeck — architecture & design decisions

Figma plugin that exports frames to an **editable PPTX** (native text, native shapes, groups) or PDF.
Everything runs locally: no server, no network (`networkAccess.allowedDomains: ["none"]`).

```
Figma nodes ──[extract/ · main thread]──▶ IR (JSON + Uint8Array assets) ──postMessage──▶
UI iframe ──[ui/images: JPEG/downscale]──▶ [build/ · pptxgenjs] ──▶ [post/ · JSZip OOXML patches] ──▶ .pptx
```

## Repository layout

```
manifest.json               Figma manifest (dynamic-page, no network)
scripts/build.mjs           esbuild: src/main.ts → dist/code.js, src/ui/main.tsx → dist/ui.html (inlined)
scripts/fixture-to-pptx.mjs IR JSON fixture → .pptx (Node) for manual checks
scripts/visual-regression.mjs  PPTX → PNG via LibreOffice, pixel diff vs Figma PNGs
src/config.ts               ALL heuristics / calibration constants
src/ir/types.ts             IR types (Deck, Slide, Element = text | shape | image | group, …)
src/ir/serialize.ts         IR ⇄ JSON (base64 assets) — "Export IR JSON" + fixtures
src/shared/settings.ts      ExportSettings (+ defaults, normalization)
src/shared/messages.ts      main ⇄ UI postMessage protocol
src/shared/lang.ts          per-run language detection (ru-RU / en-US / …)
src/fonts/mapping.ts        RIBBI font mapping + user overrides
src/fonts/embed.ts          (stage 4, experimental) font embedding prototype
src/extract/                main thread only — knows the Figma API, nothing about PPTX
src/main.ts                 plugin controller: deck list, thumbnails, export orchestration, PDF pages
src/build/                  IR → pptxgenjs (Node + browser); knows nothing about Figma
src/post/                   OOXML post-processing with JSZip (string-level, namespace-preserving)
src/ui/                     Preact UI (deck list, preview, settings, font mapping, progress, report)
tests/                      vitest: units, mapping, extract (mock nodes), build → unzip → XML asserts
docs/                       this file, font embedding research, reference analysis
```

TypeScript projects enforce the boundaries: `tsconfig.main.json` (Figma typings, no DOM),
`tsconfig.build.json` (no DOM, no Node, no Figma), `tsconfig.ui.json` (DOM), `tsconfig.test.json`.

## Units

* 1 Figma px = 1 pt. Slide inches = px / 72. EMU = pt × 12 700 (integers for integer px).
* PowerPoint accepts slide sides of 1″…56″ (`ST_SlideSizeCoordinate` 914 400…51 206 400 EMU;
  a 4992 px frame exported 1:1 = 69″ makes PowerPoint refuse the file — see reference-analysis.md).
  Frames outside the range get one uniform deck scale `s` (≤ 4032 px / longest side, ≥ 72 px /
  shortest side) applied by the builder to positions, sizes, font sizes, letter/line spacing,
  strokes, radii and shadows. `notesSz` is written as a normal portrait page.
* One presentation has one slide size: the first slide defines it; other slides of a different size
  are scaled uniformly to fit and centered (report entry `slide-scaled`).

## Extraction (main thread)

### Slides
* Deck = ordered list of frame ids persisted in `figma.root` plugin data (per document).
  "Add slides" adds selected frames (a selected SECTION adds its top-level frames; a selected child
  resolves to its top-level frame). Default order = canvas position: page order, then rows
  (y with tolerance `CONFIG.order.rowToleranceRatio` × height), then x.
* `documentAccess: "dynamic-page"` → only async APIs (`getNodeByIdAsync`, `page.loadAsync()`),
  no `documentchange`, no `figma.currentPage = …` (use `setCurrentPageAsync`).

### Geometry
* Element transform = `inverse(frame.absoluteTransform) × node.absoluteTransform` decomposed into
  PowerPoint `xfrm` terms: unrotated box centered on the node's center, clockwise rotation, flipH
  (det < 0). Skew / non-uniform scale → rasterize (`transform`).
* Raster exports are placed at `absoluteRenderBounds` (the region `exportAsync` renders by default:
  includes shadows / outside strokes). The PNG header size is checked against it; on mismatch the
  export is redone with `useAbsoluteBounds: true` and placed at `absoluteBoundingBox`.
* Clipping: an axis-aligned clip rect (slide bounds ∩ ancestor frames with `clipsContent`) travels
  down the walk. Elements fully outside it are dropped (report `outside-clip`; the reference Deck
  export put 260 of 311 text boxes of a scrolled list off-slide). Pictures partially outside are
  cropped with `<a:srcRect>`. Rectangles are intersected. Other partially clipped content
  (ellipses, rounded rects, text when `clippedText = rasterize`, anything under a *rounded* clip)
  is rasterized **together with the clip** via a temporary composite (below).

### What becomes what (mode "editable")

| Figma | PPTX |
|---|---|
| Frame fill: single visible SOLID | slide background (`<p:bg>`) |
| TEXT (solid fills) | text box (native), see Text |
| TEXT with gradient/image fill, text-on-path, flipped | picture (`gradient-text`, `text-feature`, `transform`) |
| RECTANGLE: one SOLID or LINEAR gradient fill, uniform radius, uniform stroke | `rect` / `roundRect` |
| ELLIPSE without arc data | `ellipse` |
| LINE (same caps both ends) | `line` with width, color, dash, cap, arrows |
| RECTANGLE / ELLIPSE / FRAME with one IMAGE fill (FILL / FIT / CROP w/o rotation, no filters) | picture with the original image bytes + `srcRect` crop (+ roundRect / ellipse geometry) |
| FRAME / GROUP / COMPONENT / INSTANCE (no mask, normal blend, no blur) | `<p:grpSp>` with background shape (frame fill/stroke) + children |
| Container with only vector-like descendants, no text, ≤ `iconMaxSize` | ONE picture (SVG + PNG fallback) |
| VECTOR / STAR / POLYGON / BOOLEAN_OPERATION | picture (SVG + PNG) |
| one DROP_SHADOW / INNER_SHADOW, spread 0 | `outerShdw` / `innerShdw` |
| rotation without skew | `xfrm rot` |
| layer + ancestor opacity | alpha on fill / line / text color / `alphaModFix` on pictures |

Rasterized (picture, with reasons in the report): radial / angular / diamond gradients, several
visible fills, mixed corner radii, per-side stroke weights, gradient strokes, non-normal blend
modes, masks (the mask group is rasterized as a unit), layer / background blur, several shadows or
spread ≠ 0, group opacity < 1 with overlapping children, unsupported node types, skew.

### Modes
* **editable** — the table above.
* **exact** ("Exact look") — a temporary clone of the frame with every *natively exported* text
  layer set to `opacity = 0` (not `visible = false`: that would reflow auto layout) is exported as
  one background PNG at the chosen scale; native text boxes are placed on top.
* **image** — every slide is one picture.

### Temporary composites
Some exports need "this node, clipped like its parent" or "these siblings only" (mask groups on the
slide root, rounded clips, frame background without its children). They are made on a temporary
clone moved to the page root with `relativeTransform = original.absoluteTransform` (so auto layout
of the original parent is never touched), trimmed (children removed / detached instance), exported,
and removed in `finally`. Placement uses the clone's own `absoluteRenderBounds`.

### Text
* Segments: `getStyledTextSegments(['fontName','fontSize','fontWeight','fills','letterSpacing',
  'lineHeight','textDecoration','textCase','hyperlink','listOptions','indentation',
  'paragraphSpacing','paragraphIndent','openTypeFeatures'])`.
* Paragraphs split on `\n`; ` ` stays in run text and becomes `<a:br/>`.
* The IR keeps Figma units (`lineHeight` / `letterSpacing` raw) — the builder converts:
  * line height: PIXELS → pt; PERCENT → fontSize × %; AUTO → fontSize × `CONFIG.text.autoLineHeight`
    (or `spcPct 100%` when `autoLineHeightMode = 'multiple'`); per paragraph = max over its runs;
    written as `<a:lnSpc><a:spcPts>`.
  * letter spacing: PERCENT → fontSize × % / 100 pt; PIXELS → pt; written as `spc` (1/100 pt).
* Box = Figma text box (unrotated), zero insets, `anchor` from `textAlignVertical`, no autofit.
  WIDTH_AND_HEIGHT boxes get `widthSlackPercent` extra width, expanded away from the alignment edge,
  and `wrap="none"`; fixed-width boxes whose height shows no wrapped line also get `wrap="none"`.
* `lang` per run: Cyrillic → `ru-RU`, otherwise `en-US` (`CONFIG.text.langRules`).
* Fonts: RIBBI rule (`fonts/mapping.ts`) + overrides from the UI.
* UPPER → `cap="all"` (default) or uppercase string (setting); LOWER / TITLE → string transform;
  SMALL_CAPS → `cap="small"`.
* **The `<p:txBody>` is generated by `build/`, not by pptxgenjs.** pptxgenjs 4.0.1 writes one
  `<a:pPr>` per *run*, i.e. `<a:pPr>` after `<a:r>` inside the same `<a:p>` — schema-invalid
  (the reference Deck file has exactly this). It also has no `cap`, writes `endParaRPr sz` of the
  first paragraph everywhere, hard-codes `kern="0"`, and does not escape font names. pptxgenjs
  creates the text shape (id, name, xfrm); `post/` swaps in our `<p:txBody>`.

## Build (IR → pptxgenjs) and post-processing

pptxgenjs does: package, layout, slides, backgrounds, pictures + media + rels, shapes with solid
fill / line / dash presets / arrows / shadow / rotation / flips / roundRect radius, metadata.

Verified pptxgenjs 4.0.1 units: `x/y/w/h` inches; `rectRadius` **inches**
(`adj = r·EMU·100000 / min(cx, cy)`, clamp to 50 000 — the reference Deck file has `adj = 74111`);
`shadow.blur` / `shadow.offset` **points**, `angle` degrees, `opacity` 0..1; `line.width` points;
`charSpacing` / `lineSpacing` points; `transparency` 0..100; colors `RRGGBB` without `#`.
Image `sizing: {type:'crop', x, y, w, h}` → `srcRect` relative to the full display size `w/h`.
Option objects are mutated by pptxgenjs → always pass fresh objects.

`post/` (JSZip, string-level edits that never re-serialize XML, so namespace prefixes survive):
* replace `<p:txBody>` of text shapes (matched by unique object name) + add hyperlink rels;
* wrap group members (contiguous in z-order) into `<p:grpSp>` with identity child transform;
* gradient fills (`<a:gradFill>` with `<a:lin ang scaled="0">`, stops re-projected onto the OOXML
  gradient line), line `cap` / `algn` / `custDash`;
* `asvg:svgBlip` extension + SVG media part + content type for vector pictures;
* picture geometry `roundRect` with `adj`;
* empty `<a:ln></a:ln>` → `<a:ln><a:noFill/></a:ln>`;
* docProps: title / subject / creator / lastModifiedBy / company / application — never "PptxGenJS".

Every element gets a unique object name `fd:<n>` during build; after post the names are replaced by
the Figma layer names (escaped) — names are only used as anchors between build and post.

## UI (Preact, single inlined HTML)
Deck-like layout: empty state → "Add slides"; left sidebar with numbered thumbnails
(drag-and-drop reorder, remove, sort by canvas); top bar with deck title, Settings, Clear all,
Export (PPTX / PDF / IR JSON); big preview of the selected slide; settings panel (mode, scale,
JPEG, text case, width slack, SVG, groups, gradients, image fills, clipped text, font mapping,
metadata); progress overlay with cancel; report (rasterized layers with reasons, skipped layers,
fonts the recipient must install). UI builds the PPTX (pptxgenjs + JSZip) and PDF (pdf-lib) and
downloads via a Blob link. English + Russian strings.

## Stages
1. MVP: scaffold, IR, "Exact look" (background raster + native text), build + post, tests.
2. Native elements: shapes, lines, images, SVG icons, groups, opacity, shadows, gradients, report.
3. UI & quality: previews, drag-and-drop, settings, font mapping, progress / cancel, batching, PDF.
4. Font embedding: research + experimental prototype (`docs/font-embedding.md`).
