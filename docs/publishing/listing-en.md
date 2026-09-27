# Ewento Slides — Figma Community listing (English)

Copy-paste text for the Publish modal. The Community page is one listing, so publish it in English; the Russian
version (`listing-ru.md`) is for the Ewento site, newsletters and Russian-speaking channels.

Rules followed: the name has no "Figma" / "Fig"; no other plugin or service is named as a competitor. "Figma",
"PowerPoint", "Keynote", "Google Slides" and "TinyPNG" appear only to describe formats and compatibility (see
"Wording to double-check" at the end).

## Name

**Ewento Slides**

## Tagline (pick one, ≤ 60 characters)

| # | Tagline | Characters |
|---|---|---|
| 1 (recommended) | Export frames to editable PowerPoint and PDF | 44 |
| 2 | Editable PowerPoint and PDF from your frames, 100% local | 56 |
| 3 | Frames to PPTX & PDF: native text, LED-wide slides | 50 |

The cover image uses option 1 (with "Figma" in front: "Export Figma frames to editable PowerPoint and PDF").
If you choose another tagline, update `docs/publishing/src/cover.html` and re-render.

## Description

> Paste as is. Bullets use "•" so they survive a plain-text field; switch to the editor's list formatting if it
> has one.

```text
Ewento Slides turns your frames into a real presentation. Every frame becomes a slide: text stays editable PowerPoint text, shapes stay shapes, and whatever can't be carried over natively is rasterized carefully — with a report that tells you what and why.

FOUR EXPORT FORMATS
• PowerPoint — editable (.pptx): native text, rectangles, ellipses, lines, linear gradients, shadows, groups and images with an editable crop. "Exact look" mode keeps the background true to your design and the text editable.
• PowerPoint — images (.pptx): one picture per slide. Looks exactly like your design, small file.
• PDF — vector: sharp at any zoom; images and fonts repeated across slides are stored once.
• PDF — images: one JPEG per page, a light file for email and messengers.

MADE FOR REAL EVENT DECKS
• LED screens and very wide frames: PowerPoint refuses slides larger than 56 inches. Ewento Slides scales wide frames to fit automatically — font sizes, spacing, strokes and shadows included — so the file opens and stays editable.
• Custom slide size in centimetres or inches: 16:9, 4:3, LED 3.25:1 or your agency's template (e.g. 87.82 × 27.09 cm).
• The right language on every text run (Cyrillic is tagged Russian, Latin English, and more), so PowerPoint doesn't underline your text as misspelled.
• Fonts: Windows-style RIBBI names or full style names, plus a manual mapping for any font.
• Image compression in the TinyPNG style, done locally: about 72% lighter images on a real event deck. Balanced mode is visually lossless. Raster at 1x, 2x or 3x.
• Clipping is respected: content hidden outside a frame doesn't end up on your slide.
• Export report: which layers were rasterized and why, which fonts the recipient has to install, what was skipped.

HOW TO USE
1. Select frames (or a section) and click "Add slides".
2. Drag to reorder. The slide list is saved in the file.
3. Click Export and choose a format — the file downloads.

Good to know: fonts are not embedded. Install the fonts listed in the report on the computer that opens the file. The .pptx can also be imported into Keynote and Google Slides.

PRIVATE BY DESIGN
Ewento Slides runs 100% locally. It has no network access, collects no data and needs no account — your designs never leave Figma.

Free. English and Russian interface.
Questions and bug reports: support@ewento.app
```

## Category

**Import & export** (first choice). If the modal doesn't offer it, **Design tools**.

## Tags / keywords

12 tags, in priority order (drop from the end if the modal limits the number):

`pptx` · `powerpoint` · `pdf` · `export` · `presentation` · `slides` · `keynote` · `google slides` ·
`led screen` · `pitch deck` · `deck` · `compression`

## Support contact

`support@ewento.app`

## Release notes — v1.0

```text
First public release.
• Export frames to editable PowerPoint, PowerPoint images, vector PDF and image PDF
• Wide LED frames auto-fit PowerPoint's 56-inch limit; custom slide sizes in cm or inches
• Local image compression (about −72% on a real deck), 1x / 2x / 3x raster
• Correct language per text run, RIBBI or full font names, manual font mapping
• Export report: rasterized layers with reasons, fonts to install, skipped layers
• English and Russian interface
```

## Wording to double-check before publishing

- **Keynote and Google Slides.** The sentence "The .pptx can also be imported into Keynote and Google Slides" is
  there for search and expectations. Open one exported file in both before publishing; if either misbehaves,
  delete the sentence (and the `keynote` / `google slides` tags if you want to be strict).
- **"TinyPNG style".** TinyPNG is a third-party service, not named as a competitor, but it is a trademark. The
  plugin UI says "Balanced — like TinyPNG" too. If a reviewer objects, replace it with "palette + JPEG
  compression, like the popular PNG optimizers" here, in `carousel-04` and in the UI.
- **"About 72%".** Measured on one real deck (4016 KB → 1134 KB, Balanced, `npm run compress:bench`). Gains depend
  on the content: huge smooth gradients shrink much less (README → "Сжатие картинок").
