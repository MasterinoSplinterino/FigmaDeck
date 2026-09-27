# Testing FigmaDeck

```bash
npm test                          # all vitest suites (tests/**/*.test.ts)
npx vitest run tests/build        # one folder / file
npm run typecheck                 # the five TypeScript projects (main, build, ui, test, scripts)
```

Node 22. Optional tools — the suites that need them are **skipped** (not failed) when they are missing:

| Tool | Used by | Install (Debian / Ubuntu) |
|---|---|---|
| LibreOffice Impress (`soffice`) | `tests/build/libreoffice.test.ts`, `tests/fonts/libreoffice-embed.test.ts`, `tests/fonts/visual-regression.test.ts`, `npm run visual` | `apt install libreoffice-impress` |
| poppler (`pdfinfo`, `pdftoppm`, `pdffonts`) | same | `apt install poppler-utils` |
| Chromium for playwright-core | `tests/build/browser.test.ts` (the builder must run in a browser), `npm run ui:screenshots` | `npx playwright-core install chromium`, or set `PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers` is probed too) |
| Liberation Sans TTFs | the real-font cases in `tests/fonts/` | `apt install fonts-liberation` (or `fonts-liberation2`) |

## Test layers

| Layer | Where | What it proves |
|---|---|---|
| Units & mapping | `tests/unit/` | px → pt / EMU, line height / letter spacing conversion, `lang` detection, RIBBI font mapping, gradient math, IR JSON (de)serialization |
| Extraction | `tests/extract/` | `src/extract/` against mock Figma nodes (`tests/helpers/figma-mocks.ts`: real geometry, fake `exportAsync` returning valid PNGs): classification, geometry, clipping, text segments, raster decisions, report entries, slide order |
| Build | `tests/build/` | IR → `buildPptx` → unzip → XML assertions (`tests/helpers/ooxml.ts`): insets, `lnSpc`, `spc`, `lang`, typefaces, `<p:pic>` vs `<p:sp>` counts, groups, gradients, slide size limits (`slide-size.test.ts`), post-processing; `validatePackage` checks what makes PowerPoint show its repair dialog (malformed XML, dangling relationships, parts without content type, duplicate ids, `<a:pPr>` position, slide size outside 1″…56″, "PptxGenJS" leftovers) |
| Browser | `tests/build/browser.test.ts` | the builder bundled like the plugin UI, run in headless Chromium, byte-identical to the Node build |
| LibreOffice smoke | `tests/build/libreoffice.test.ts` | every fixture opens in LibreOffice and converts to a PDF with one page per slide and the expected page size |
| Fonts (stage 4) | `tests/fonts/` | font parsing, fsType decoding, `.fntdata` (EOT) layout, package structure after embedding, LibreOffice end-to-end probe; also the tests of the visual regression script. `tests/fonts/embed-cli.ts` (not a suite) makes files for the manual stage-4 check |
| UI logic | `tests/ui/` | the export pipeline with injected dependencies (`exporter.test.ts`: all four targets + IR JSON, cancel, progress localized from main's numeric fields, re-sent assets replace older ones), PDF assembly (`pdf.test.ts`: merge, duplicate-resource dedupe on synthetic PDFs that embed the same image per frame, image PDF page size = frame px as pt capped at 14 400 pt, JPEG passed through), slide size model (`slide-size.test.ts`: cm / in, presets incl. the agency template 87.82 × 27.09 cm, letterbox check), settings → builder options, report model / text, i18n (en / ru keys, plurals, every `RasterReason` labelled), image optimization plans, reorder, state reducer |
| UI screenshots | `npm run ui:screenshots` (manual) | the real UI bundle in headless Chromium with injected main-thread messages: every screen, a PPTX built in the browser, a vector PDF merged from per-frame PDFs (asserts the repeated image is stored once), the slide size settings with the agency preset, drag-and-drop / keyboard checks. Output: `docs/screenshots/` |
| Visual regression | `npm run visual` (manual / CI job) | LibreOffice rendering vs PNGs exported from Figma — rough |
| Manual | `docs/MANUAL-CHECKS.md` | Figma, PowerPoint (Windows / Mac), Keynote, Google Slides |

LibreOffice is not PowerPoint: the LibreOffice-based checks catch broken packages and gross layout errors, not
1–2 px text differences. The final word is always a manual check in PowerPoint.

## Fixtures

IR fixtures live in `tests/fixtures/*.ir.json` (the "Export IR JSON" format: `src/ir/serialize.ts`, assets as
base64). `tests/fixtures/load.ts` lists them in `FIXTURE_NAMES`; the build, browser and LibreOffice suites run
every listed fixture.

### Synthetic fixtures (deterministic)

`npm run fixtures` (`scripts/make-fixtures.ts`) writes them from code (`tests/fixtures/ir-builders.ts`; bitmaps
generated with pngjs):

1. add a builder function to `scripts/make-fixtures.ts` and register its output;
2. `npm run fixtures`;
3. add the name to `FIXTURE_NAMES` in `tests/fixtures/load.ts`;
4. add targeted assertions (e.g. in `tests/build/fixtures.test.ts`).

Keep synthetic fixtures small (no real photos, few KB) and free of third-party content.

### Real fixtures from Figma

1. In the plugin: add the frames, then **Export → IR JSON (debug)**. The file is `<deck title>.figmadeck.json`.
2. Check it builds: `npm run fixture:pptx -- "<file>.figmadeck.json" out.pptx` (prints the report and fonts;
   `--slide-size=<w>x<h>` in inches and `--font-naming=ribbi|full` mirror the plugin settings).
3. Copy it to `tests/fixtures/<name>.ir.json` and add `<name>` to `FIXTURE_NAMES`.

The IR contains the layer names, all text and the original image bytes of the frames. Only commit files whose
content may be public; otherwise keep them out of the repository (e.g. a git-ignored folder) and run the
scripts on them locally. Large photos make the fixture large — replace them with small ones in Figma first if
the layout is what matters.

## Visual regression

```bash
npm run visual -- --fixture tests/fixtures/diploma.ir.json \
    --expected tests/visual/expected/diploma [--threshold 0.1] [--max-diff 0.02] [--out tests/visual/out]
```

Pipeline: IR → `buildPptx` (default settings) → LibreOffice → PDF → `pdftoppm` renders each page at the width of
its expected PNG → the page is cropped to the frame's placement (slides of other sizes are letterboxed by the
builder) → `pixelmatch`. Transparent pixels of the expected PNG are composited over white.

* `--pptx file.pptx` compares an existing PPTX instead of building one (with `--fixture` as well, the fixture only
  supplies slide names and placements; without it slides are matched by number only).
* `--threshold`: pixelmatch per-pixel colour threshold (0..1, smaller = stricter). `--max-diff`: a slide fails when
  more than this share of its pixels differ. Defaults: `CONFIG.visual`.
* Output in `<out>/<fixture name>/`: `deck.pptx`, `deck.pdf`, `actual/<n>.png`, `diff/<n>.png` (red = different,
  yellow = anti-aliasing), `summary.json` (per slide: status, diff ratio, file paths).
* Exit code: `0` all compared slides within `--max-diff`; `1` a slide failed (`fail`, `size-mismatch`,
  `missing-page`) or nothing was compared; `2` usage / tool error. Slides without an expected PNG are listed as
  `missing-expected` and do not fail the run.

Text will rarely match to the pixel (font rasterizers differ, and LibreOffice substitutes fonts that are not
installed — install the deck's fonts on the machine running the check). Useful thresholds are found per fixture;
start with `--max-diff 0.02` for shape-only slides and `0.05`–`0.1` for text-heavy ones.

### Exporting the expected PNGs from Figma

1. Select the slide frames (the same ones that are in the deck).
2. Right panel → **Export** → `+` → format **PNG**, size **1x** (or 2x — any width works, the render follows the
   PNG's width). Keep the frames' own background (no transparent export of a frame without fill if the slide
   has a background colour in the IR — it is composited over white).
3. **Export N layers** → Figma saves `<frame name>.png` (or `<frame name>@2x.png`; frames with the same name get
   numbered by Figma — rename those to `<slide number>.png`).
4. Put the files in one folder per fixture, e.g. `tests/visual/expected/<fixture>/`. Names are matched by slide
   number first (`1.png`, `2.png`, … in deck order), then by frame name (case-insensitive; `/ \ : * ? " < > |`
   → `_`; an `@2x`-style suffix is ignored). Duplicate frame names must use the number form.

## UI screenshots

```bash
npm run ui:screenshots                                   # dark theme, English: every scene
npm run ui:screenshots -- --theme light --only empty,deck,settings,report
npm run ui:screenshots -- --lang ru --only deck,export-menu,settings,settings-slide-size,settings-fonts,progress,report,report-pdf
```

The script bundles the UI like `npm run build`, opens it in headless Chromium (same Chromium lookup as the browser
suite) and injects the main-thread messages. All scenes always run (so the checks run too); `--only` limits which
PNGs are written to `docs/screenshots/<scene>[-light][-ru].png`. It fails on page errors, when the downloaded PPTX
is not a ZIP, when the merged vector PDF keeps more than one copy of the repeated image, when the agency preset shows
no letterbox warning or is not saved, when `preview-failed` leaves the spinner running, and when drag-and-drop /
keyboard interactions send the wrong messages.
