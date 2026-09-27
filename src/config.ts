/**
 * All heuristics, calibration constants and magic numbers live here.
 * Nothing in extract/, build/, post/ or ui/ should hard-code a tunable number.
 *
 * Environment-neutral: imported by the Figma main thread, the UI iframe and Node tests.
 */
export const CONFIG = {
  /** Unit system. 1 Figma px == 1 pt (slide inches = px / 72). */
  units: {
    pxPerInch: 72,
    emuPerInch: 914400,
    emuPerPt: 12700,
  },

  /** PowerPoint slide size limits (inches). Frames larger than this are scaled down uniformly. */
  slide: {
    maxInches: 56,
    minInches: 1,
  },

  /** Default slide order: rows first (y with tolerance), then x. */
  order: {
    /** Two frames are in the same row when their top edges differ by less than this share of the smaller height. */
    rowToleranceRatio: 0.5,
  },

  text: {
    /** Figma `lineHeight: AUTO` → fontSize × this (calibrate per font family if needed). */
    autoLineHeight: 1.2,
    /**
     * How AUTO line-height is written: 'points' → <a:spcPts> (fontSize × autoLineHeight),
     * 'multiple' → <a:spcPct 100%> (lets PowerPoint use the font's own metrics).
     */
    autoLineHeightMode: 'points' as 'points' | 'multiple',
    /** Extra width for `textAutoResize: WIDTH_AND_HEIGHT` boxes, % of width (PowerPoint wraps the last word otherwise). */
    widthSlackPercent: 3,
    /** Extra width for fixed-width boxes (NONE / HEIGHT / TRUNCATE), % of width. */
    fixedWidthSlackPercent: 0,
    /**
     * Write `wrap="none"` when Figma did not wrap any line (WIDTH_AND_HEIGHT, or the box height fits
     * one line per paragraph). Removes the risk of PowerPoint wrapping a line Figma kept on one line.
     */
    noWrapSingleLine: true,
    /** Tolerance (share of the smallest line height) used when deciding that a fixed box has no wrapped lines. */
    singleLineTolerance: 0.5,
    /** Vertical nudge of the text box (em of the first run's font size, + = down). Calibration knob, default 0. */
    firstLineOffsetEm: 0,
    /** `kern` attribute (min pt size for kerning). Figma always kerns → kerning from 1 pt up. */
    kernMinPt: 1,
    /** Language detection per run. First matching rule wins, otherwise `defaultLang`. */
    defaultLang: 'en-US',
    langRules: [
      { test: /[Ѐ-ӿԀ-ԯ]/, lang: 'ru-RU' },
      { test: /[Ͱ-Ͽ]/, lang: 'el-GR' },
      { test: /[֐-׿]/, lang: 'he-IL' },
      { test: /[؀-ۿ]/, lang: 'ar-SA' },
      { test: /[぀-ヿ]/, lang: 'ja-JP' },
      { test: /[가-힯]/, lang: 'ko-KR' },
      { test: /[一-鿿]/, lang: 'zh-CN' },
    ] as ReadonlyArray<{ test: RegExp; lang: string }>,
    /** List marker indent (em of the paragraph font size) per nesting level. */
    listIndentEm: 1.5,
    /** Bullet characters per nesting level (unordered lists). */
    bulletChars: ['•', '◦', '▪'] as readonly string[],
  },

  fonts: {
    /** Style names treated as the RIBBI "Regular" member (case-insensitive, spaces/hyphens ignored). */
    regularNames: ['regular', 'normal', 'plain'] as readonly string[],
    /**
     * "Book" / "Roman" are usually separate Windows families ("Futura PT Book"), so by default they
     * keep the full name. Set to true to treat them as Regular.
     */
    bookNames: ['book', 'roman'] as readonly string[],
    treatBookAsRegular: false,
    /** Words that turn a following "Bold" into a different weight ("Extra Bold", "Semi Bold"). */
    boldPrefixes: ['semi', 'demi', 'extra', 'ultra', 'super'] as readonly string[],
  },

  raster: {
    /** Default export scale (1x / 2x / 3x). */
    defaultScale: 2 as 1 | 2 | 3,
    /** Figma refuses/degrades very large exports; the scale is lowered so the longest side stays below this. */
    maxSidePx: 8192,
    /** A container with only vector-like descendants and no text, not larger than this (px), is exported as ONE image. */
    iconMaxSize: 480,
    /** …and must contain at least this many vector-like leaves to be merged (1 = any icon group). */
    iconMinLeaves: 1,
    /** Tolerance (px) when comparing an exported bitmap size with the expected render bounds. */
    boundsTolerancePx: 1.5,
    /** Default JPEG quality when "compress photos" is on. */
    jpegQuality: 0.85,
    /** Only use the JPEG when it is at least this much smaller than the PNG. */
    jpegMinSavingRatio: 0.9,
    /** Downscale original image fills that are much larger than needed: max source px per displayed px × scale. */
    maxImageOversample: 1.5,
    /** Elements smaller than this (px, both sides) are dropped as invisible noise. */
    minVisibleSizePx: 0.01,
  },

  shadow: {
    /** Figma blur radius (px) → OOXML blurRad (pt). Calibration knob. */
    blurFactor: 1.0,
  },

  gradient: {
    /** Stops closer than this (0..1) are merged when clamping to the OOXML 0..100% range. */
    stopEpsilon: 1e-4,
    /**
     * A gradient whose parameter changes by less than this across the whole box (|∇t| × longest side,
     * gradient units) is written as a solid fill of its first stop.
     */
    degenerateLength: 1e-6,
  },

  /** PPTX writer choices (build/ + post/). */
  pptx: {
    /** Notes page size, EMU: a normal portrait page (pptxgenjs writes the swapped slide size). */
    notesWidthEmu: 6858000,
    notesHeightEmu: 9144000,
    /** `baseline` of superscript / subscript runs (1/1000 %; PowerPoint's own defaults). */
    superscriptBaseline: 30000,
    subscriptBaseline: -25000,
    /** Miter limit written for `join: miter` strokes (1/1000 %; 800 % = PowerPoint default). */
    miterLimit: 800000,
    /** Keep the run color on hyperlinks (Office 2019+ `ahyp:hlinkClr val="tx"`) instead of the theme hyperlink color. */
    hyperlinkUseTextColor: true,
    /** Store byte-identical media files once (a logo or background repeated on every slide). */
    dedupeMedia: true,
    /**
     * Inside / outside strokes are emulated by shrinking / growing the geometry (the fill then extends
     * under half of the stroke). When the stroke is semi-transparent (color alpha × layer opacity < 1)
     * that would show, so the fill and the stroke are emitted as two shapes, the fill keeping its
     * original geometry. Gradient fills are re-framed onto the adjusted geometry either way.
     */
    splitAlignedStroke: true,
  },

  ui: {
    windowWidth: 1000,
    windowHeight: 640,
    minWidth: 720,
    minHeight: 480,
    thumbnailWidth: 320,
    previewWidth: 1400,
    /** Debounce (ms) before changed settings are persisted with `save-settings`. */
    settingsSaveDebounceMs: 400,
    /** Min interval (ms) between `resize` messages while the resize grip is dragged. */
    resizeThrottleMs: 50,
    /** Delay (ms) before the big preview is requested after the selection changes (holding ↑/↓). */
    previewRequestDelayMs: 120,
    /** The preview spinner gives up after this long (ms) when main sends no preview (export failed). */
    previewTimeoutMs: 20000,
    /** Thumbnails are re-requested when the plugin window regains focus, at most this often (ms). */
    thumbnailRefreshMinIntervalMs: 5000,
    /** Toast lifetime (ms); errors stay longer. */
    toastMs: 3500,
    errorToastMs: 7000,
    /** Pointer travel (px) before a press on a thumbnail turns into a drag. */
    dragThresholdPx: 4,
    /** Auto-scroll of the slide list while dragging: edge zone height (px) and max speed (px per frame). */
    dragAutoScrollZonePx: 36,
    dragAutoScrollMaxPx: 14,
    /** Size of the floating drag preview relative to the thumbnail. */
    dragGhostScale: 0.7,
    /** Sidebar thumbnails (px): fixed width, height from the frame aspect, clamped (very tall frames shrink in width). */
    listThumbWidthPx: 108,
    listThumbMaxHeightPx: 150,
    listThumbMinHeightPx: 24,
    /**
     * Share of the overall progress bar per export phase (UI progress overlay). Phases that a format
     * does not run are skipped and the remaining weights are renormalized.
     */
    progressWeights: { extract: 0.55, pdf: 0.8, images: 0.1, build: 0.2, package: 0.15, merge: 0.2 },
    /** JPEG quality slider range in the settings (0..1). */
    jpegQualityMin: 0.5,
    jpegQualityMax: 1,
    jpegQualityStep: 0.05,
    /** Width slack slider range (% of the text box width). */
    widthSlackMax: 10,
    widthSlackStep: 0.5,
    /** Custom slide size inputs: step (inches). Limits come from CONFIG.slide. */
    slideSizeStepIn: 0.001,
    /** Custom slide size inputs: step (centimeters). */
    slideSizeStepCm: 0.01,
    /**
     * Frame vs slide aspect ratios that differ by more than this share (0.001 = 0.1 %) show the
     * letterbox warning in the "Slide size" settings.
     */
    slideRatioTolerance: 0.001,
    /** A preset is shown as selected when both sides are within this many inches of it. */
    slidePresetToleranceIn: 0.0006,
    /**
     * UI-side image optimization: an image-fill is only downscaled when the target side is at most this
     * share of the current side (skips re-encoding for marginal gains).
     */
    imageDownscaleMaxRatio: 0.9,
    /** JPEG quality used when a JPEG original is downscaled while "JPEG compression" is off (0..1). */
    imageReencodeJpegQuality: 0.92,
    /** Transparency scan reads the bitmap in bands of about this many pixels (bounds peak memory). */
    imageAlphaScanBandPx: 4000000,
    /** After "Cancel", the overlay waits this long (ms) for main to confirm before closing anyway. */
    cancelTimeoutMs: 10000,
    /** Object URLs of downloads are revoked after this delay (ms), once the browser has picked the file up. */
    downloadRevokeMs: 60000,
    /** Max length (characters) of a downloaded file's base name. */
    maxFileNameLength: 120,
    /** Base name used when the deck title is empty. */
    fallbackFileName: 'FigmaDeck',
    /** Max layers listed per slide in the report dialog before "and N more" (the text export lists all). */
    reportMaxItemsPerSlide: 50,
  },

  /** PDF assembly in the UI (src/ui/pdf.ts). */
  pdf: {
    /**
     * Max page side (pt) of the image PDF. 14400 pt = 200″ is the PDF user-unit limit most viewers
     * enforce (Acrobat refuses larger pages); bigger frames are scaled down uniformly.
     */
    maxPageSidePt: 14400,
    /**
     * Vector PDF: store byte-identical resources (images, fonts, ICC profiles…) that Figma embeds once
     * per frame only once in the merged file.
     */
    dedupeResources: true,
    /** Dedupe passes (a pass can make objects that reference merged resources identical in turn). */
    dedupeMaxPasses: 8,
  },

  export: {
    /** Yield to the event loop every N visited nodes (keeps Figma responsive, lets "Cancel" through). */
    yieldEveryNodes: 25,
    /** Max parallel exportAsync calls. */
    exportConcurrency: 4,
  },

  /** Extraction (main thread, extract/): tolerances and Figma-behavior assumptions. */
  extract: {
    /**
     * Tolerance (unitless) when checking that a transform is a pure rotation / flip: axes orthogonal
     * and of unit length. Beyond it the node counts as skewed / scaled and is rasterized (`transform`).
     */
    matrixEpsilon: 1e-3,
    /** Rotations within this many degrees of a multiple of 90° are snapped to it (float noise). */
    rotationSnapDeg: 0.01,
    /** Geometric tolerance (px) for containment, "covers the frame" and rounded-corner tests. */
    geometryEpsilonPx: 0.5,
    /** Two siblings overlap (group-opacity rule) when their render bounds share more than this area (px²). */
    overlapMinAreaPx2: 1,
    /** Crop fractions (0..1) below this are written as 0. */
    cropEpsilon: 1e-4,
    /**
     * `exportAsync` renders the node with its own opacity baked into the bitmap, so a rasterized node
     * gets only its ancestors' opacity in the IR. Flip if calibration shows otherwise.
     */
    exportIncludesOwnOpacity: true,
    /** SVG exports: text as outlines (exact look, no font dependency in the SVG). */
    svgOutlineText: true,
    /** An SVG whose root size differs from the PNG region by more than this (px) is dropped (PNG only). */
    svgSizeTolerancePx: 1.5,
    /** Max size (bytes) of an SVG export that is kept next to the PNG fallback. */
    svgMaxBytes: 2000000,
    /** Name + plugin-data marker of temporary composite nodes (so leftovers can be found and removed). */
    tempNodeName: '[FigmaDeck temp]',
    tempPluginDataKey: 'figmadeck.temp',
    /** Walk progress is reported every N visited layers… */
    progressEveryNodes: 100,
    /** …and the main thread forwards at most one progress message per this many ms. */
    progressIntervalMs: 100,
    /**
     * `absoluteRenderBounds` are already clipped by ancestors with `clipsContent` (docs/figma-api-notes.md).
     * A render-bounds edge within this distance (px) of a clipping ancestor's edge counts as "cut there"
     * when deciding whether a NATIVE element (text, shape, image fill) needs manual clipping.
     */
    clipEdgeTolerancePx: 0.05,
    /**
     * Resolve `lineHeight: AUTO` to the font's real (rounded) line height by measuring a temporary one-line
     * text node per (font, size) when the font can be loaded; otherwise AUTO stays in the IR and the
     * builder uses `text.autoLineHeight`.
     */
    measureAutoLineHeight: true,
    /** Characters of the temporary text node used for the AUTO line-height measurement. */
    autoLineHeightSample: 'Ag',
  },

  /**
   * Stage 4 (EXPERIMENTAL, not wired into the UI): font embedding prototype, src/fonts/embed.ts.
   * Research and sources: docs/font-embedding.md.
   */
  fontEmbed: {
    /**
     * EOT header `Charset` byte (0 = ANSI). LibreOffice's PPTX exporter and pptxboss (whose header test
     * mirrors PowerPoint-written parts) both write 0; the EOT spec's "no preference" value would be 1.
     */
    eotCharset: 0,
    /**
     * Embed fonts whose OS/2 fsType is "Preview & Print" (0x0004). PowerPoint opens such a file
     * read-only on machines where the font is not installed; the prototype warns either way.
     */
    allowPreviewPrint: true,
    /**
     * Embed OpenType fonts with CFF (PostScript) outlines ("OTTO"). PowerPoint's support for them is
     * unverified (and Office's own PDF export never embeds CFF fonts); TrueType outlines are the safe choice.
     */
    allowCff: true,
    /** Refuse font files larger than this (bytes). The EOT is written uncompressed: the PPTX grows by ~this much. */
    maxFontBytes: 50 * 1024 * 1024,
    /** DEFLATE level used when the package is re-zipped after embedding (0..9). */
    zipCompressionLevel: 6,
  },

  /** scripts/visual-regression.ts defaults (LibreOffice render vs PNGs exported from Figma). */
  visual: {
    /** pixelmatch per-pixel color threshold (0..1, smaller = more sensitive). */
    threshold: 0.1,
    /** A slide fails when more than this share (0..1) of its pixels differ. */
    maxDiffRatio: 0.02,
    /** Rendered vs expected height difference (px) that is tolerated by comparing the common area only. */
    heightTolerancePx: 2,
    /** Timeout (ms) of one LibreOffice conversion. */
    sofficeTimeoutMs: 180000,
    /** Default output directory (relative to the repository root). */
    outDir: 'tests/visual/out',
  },

  /** Metadata written to docProps (never the PptxGenJS defaults). */
  meta: {
    application: 'FigmaDeck',
    defaultAuthor: 'FigmaDeck',
    defaultCompany: '',
  },
} as const;

export type Config = typeof CONFIG;
