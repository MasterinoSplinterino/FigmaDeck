# Reference analysis: what the Deck plugin writes (and what we do differently)

Two PPTX files exported by Deck (deck.is) were inspected: a 584×437 slide exported with the
"Retina" option, and a 4992×1536 ("5K wide") slide that PowerPoint refuses to open.
The files themselves are not stored in this repository (they contain third-party content).

## 1. The 4992×1536 file does not open in PowerPoint — cause

```xml
<p:sldSz cx="63395352" cy="19504152"/>   <!-- 4991.76 × 1535.76 pt = 69.33″ × 21.33″ -->
```

ECMA-376 `ST_SlideSizeCoordinate` allows **914 400 … 51 206 400 EMU (1″ … 56″)** per side.
Deck maps 1 px → 1 pt without checking the limit, so any frame wider or taller than **4032 px**
produces a file PowerPoint rejects. All XML parts are well-formed (checked with `xmllint`);
the slide size is the only violation. The background was also written as a single 9984×3072 PNG
(14.5 MB).

**FigmaDeck:** `build/` computes one uniform factor per deck,
`s = min(1, 4032 / max(w, h))` (and `≥ 72 / min(w, h)` for frames under 1″), writes a valid
`sldSz`, and scales every coordinate, font size, letter / line spacing, stroke, radius and shadow by
`s`. Text keeps its relative look (a 64 px title on a 4992 px frame becomes 51.7 pt on a 56″ slide).
Raster exports keep their pixel density relative to the frame, and `notesSz` is written as a normal
portrait page instead of the swapped slide size. Slides of other sizes in the same deck are scaled
uniformly into the first slide's size and centered (report entry `slide-scaled`). Regression test:
`tests/build/slide-size.test.ts`.

## 2. Retina file (584×437 → 1168×874 px bitmaps)

| Observation | Count / value | FigmaDeck |
|---|---|---|
| Text boxes placed **outside the slide** (content of a clipped, scrolled list) | 260 of 311 | clip rect propagated; fully clipped layers dropped (`outside-clip` in report), partially clipped ones cropped / rasterized with the clip |
| 1×1 px transparent PNGs (exports of clipped-away layers) | 157 | not produced (layers outside the clip are skipped) |
| Empty `rect` shapes (no fill, no line) for frames | 361 | frames without visible paint produce no shape |
| `roundRect` `adj` | 74111 (> 50000 max) | radius clamped to `min(w, h) / 2` |
| `lang` | `en-US` for Russian text | per run: Cyrillic → `ru-RU` |
| Font faces | `SB Sans Text Regular`, `SB Sans Display Bold` … | RIBBI: `SB Sans Text`, `SB Sans Display` + `b="1"`; non-RIBBI styles keep the full name |
| Several `<a:pPr>` inside one `<a:p>` (one per run, e.g. around a hyperlink) | yes | own `<p:txBody>` generator: one `<a:pPr>` per paragraph |
| `alpha` | always 100000 | layer / paint opacity mapped |
| Groups | none (`<p:grpSp>` = 0) | Figma groups / frames preserved |
| Vectors | SVG + PNG fallback per tiny layer (29 `svgBlip`) | icon-like containers exported once |
| Metadata | `PptxGenJS` creator / title / subject | our author / company / title |
| Line spacing | `<a:spcPts>` absolute (e.g. 2310 for 21 pt × 110 %) | same |
| Letter spacing | `spc` in 1/100 pt (e.g. −15) | same |
| Hyperlinks | `mailto:` via `hlinkClick` | same (+ jumps to exported slides) |

## 3. PowerPoint compatibility findings (verified by bisection in PowerPoint 365, Windows)

A FigmaDeck export that passed XSD validation was refused by PowerPoint ("PowerPoint can't read
<file>"). Variants of the same file, each changing one factor, were opened by the user:

| Variant | Opens |
|---|---|
| ZIP repacked without compression, our XML | no |
| our DEFLATE ZIP, pptxgenjs `presentation.xml` / `[Content_Types].xml` / docProps | yes |
| our file with ZIP "version needed" 1.0 → 2.0 | no |
| only `docProps/core.xml`, `docProps/app.xml` or `[Content_Types].xml` reverted | no |
| only `ppt/presentation.xml` reverted | **yes** |
| pptxgenjs child order + portrait `notesSz` 6858000×9144000 | **yes** |
| XSD child order (`notesMasterIdLst` before `sldIdLst`) + pptxgenjs `notesSz` | no |

Conclusion: in pptxgenjs packages PowerPoint requires `<p:sldIdLst>` to stay **before**
`<p:notesMasterIdLst>` (pptxgenjs's order), although the ECMA-376 XSD sequence is the opposite.
FigmaDeck keeps pptxgenjs's order (`src/post/package.ts`, regression test
`tests/build/ooxml-regressions.test.ts`); the XSD test normalizes only that order in its copy.
Changing `notesSz`, DEFLATE compression, docProps and content types are all fine.
