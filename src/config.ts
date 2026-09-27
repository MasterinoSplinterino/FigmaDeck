/**
 * All heuristics, calibration constants and magic numbers live here.
 * Nothing in extract/, build/, post/ or ui/ should hard-code a tunable number.
 *
 * Environment-neutral: imported by the Figma main thread, the UI iframe and Node tests.
 */

/**
 * The product name users see (plugin window title, headers, report, file metadata, fallback file
 * name) — read it as CONFIG.meta.productName. Change it together with manifest.json "name":
 * `node scripts/rename.mjs "New Name"` (Figma does not allow "Figma" in Community plugin names).
 */
const PRODUCT_NAME = 'FigmaDeck';

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
    /**
     * Image compression (ExportSettings.compression, src/ui/images.ts → src/compress in a Web Worker).
     * `strong` caps the JPEG quality at this value (0..1): quality = min(jpegQuality, this).
     */
    imageStrongJpegQuality: 0.75,
    /**
     * A bitmap that may become JPEG (opaque photo / background / raster) with more than this many
     * distinct colours skips the palette and lossless attempts: on Deck exports and synthetic slides
     * (photos, gradients) the JPEG was 3–40× smaller than the best palette PNG, and the palette search
     * costs ~1–2 s per megapixel. Flat graphics (≤ this many colours) still try them all: there the
     * palette PNG was ~5× smaller than the JPEG. Same limit as CONFIG.compress.flatMaxColors.
     */
    imagePaletteMaxColorsWithJpeg: 4096,
    /**
     * The lossless re-encode (after a successful lossy palette) is skipped when the palette PNG is at
     * most this share of the original bytes: on Deck PNGs the lossless re-encode was always ≥ 1.8× the
     * palette PNG (Figma's own PNGs shrink only 5–45 % losslessly), and it costs ~0.5–1 s per megapixel.
     */
    imageLosslessSkipRatio: 0.5,
    /**
     * Bitmaps with more pixels than this get no palette / lossless attempt (a 30 MP bitmap takes
     * 12–30 s and several hundred MB); the exact palette (≤ 256 colours) and JPEG still apply.
     */
    imageCompressMaxPixels: 25000000,
    /**
     * The compression worker must post its "ready" message within this time (ms) after it is created;
     * otherwise the next way to start it is tried (blob URL → data URL), then the main thread.
     */
    compressWorkerStartTimeoutMs: 8000,
    /** After "Cancel", the overlay waits this long (ms) for main to confirm before closing anyway. */
    cancelTimeoutMs: 10000,
    /** Object URLs of downloads are revoked after this delay (ms), once the browser has picked the file up. */
    downloadRevokeMs: 60000,
    /** Max length (characters) of a downloaded file's base name. */
    maxFileNameLength: 120,
    /** Base name used when the deck title is empty. */
    fallbackFileName: PRODUCT_NAME,
    /**
     * The UI shows "Couldn't connect" with a retry button when main's `init` has not arrived this long
     * (ms) after `ui-ready`.
     */
    bootTimeoutMs: 15000,
    /** Settings → Fonts stops its spinner when main's `fonts` has not arrived this long (ms) after the request. */
    fontsTimeoutMs: 30000,
    /**
     * Sidebar thumbnails still pending stop their loading shimmer when no thumbnail at all has arrived
     * for this long (ms): main renders them one by one and skips frames it cannot export.
     */
    thumbnailStallMs: 20000,
    /** Error texts shown in toasts are cut to their first line and at most this many characters. */
    errorMessageMaxChars: 200,
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
     * A DROP_SHADOW with `showShadowBehindNode: false` (Figma's default) is not drawn behind the node,
     * while PowerPoint draws an outer shadow behind the whole shape — visible through a translucent fill.
     * A shape / text / picture with such a shadow whose effective fill alpha (paint × layer × ancestors'
     * opacity; no fill = 0) is below this value is rasterized (`effects`). Lower it to keep nearly
     * opaque layers native (the shadow then shows through faintly).
     */
    shadowKnockoutMaxAlpha: 0.999,
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

  /**
   * PNG compression (src/compress, pngquant / TinyPNG-like): ≤256-colour palette with adaptive
   * dithering behind a quality gate, plus a lossless re-encoder. Evidence: scripts/compress-bench.ts.
   */
  compress: {
    /** Above this many pixels the palette is searched on a sample (the full image is still remapped). */
    maxPixels: 12000000,
    /** Approximate sample size (pixels) used above maxPixels. */
    samplePixels: 4000000,
    /** Max distinct histogram colours; beyond it colours are binned (one low bit per channel per step). */
    maxHistogramColors: 131072,
    /** k-means refinement after median cut: max iterations and minimum relative error gain per iteration. */
    kmeansIterations: 8,
    kmeansMinImprovement: 0.002,
    /** A palette entry snaps to its cell's most frequent exact colour (≥ this share, ≤ this distance in 8-bit levels). */
    snapMinShare: 0.3,
    snapMaxDistance: 3,
    /** Channel weights (r, g, b) of the premultiplied error metric used by the quantizer and the ditherer. */
    channelWeights: [1, 1, 1] as readonly [number, number, number],
    /**
     * Histogram importance per 8×8 block (libimagequant's noise map): weight = min + (1 − min) /
     * (1 + (activity / scale)²), activity = mean |second difference| (8-bit levels). Busy texture hides
     * errors, so smooth gradients get more of the palette.
     */
    importance: { minWeight: 0.33, activityScale: 3 },
    /** Metrics: block activity (8-bit levels) that halves a block's error (texture masking). */
    maskActivity: 0.5,
    /**
     * Feedback rounds while the gate fails or banding is above the level's `targetBanding`: blocks
     * whose masked mean error exceeds `minError` get their histogram weight × (1 + (error / scale)²) and
     * the palette is searched again; a round is kept if it makes the gate pass, or if banding drops
     * without losing more than maxPsnrLoss (dB) / maxSsimLoss (ssimHalf). Not run when PSNR fails
     * (feedback cannot raise it) nor above `retryMaxPixels`.
     */
    feedback: { rounds: 2, minError: 0.5, scale: 0.5, maxPsnrLoss: 1, maxSsimLoss: 0.003 },
    /**
     * Above this many pixels only one palette attempt is made (no feedback rounds, no smaller palettes):
     * each attempt costs ~0.4–0.6 s per megapixel in JS.
     */
    retryMaxPixels: 4000000,
    dither: {
      /** pngquant-style per-pixel dither map (less on edges / noise, full inside flat-mapped areas). */
      adaptive: true,
      /** Dither level drop per 8-bit level of local second difference (edges). */
      edgeScale: 1,
      /** Accumulated error below this (squared, working space) is dropped instead of diffused. */
      minError2: 2,
      /** Larger errors are damped: threshold = max(factor × plain-remap MSE, min). */
      maxErrorFactor: 2.4,
      maxErrorMin: 16,
      /** How far (8-bit levels) a dithered target may leave the valid premultiplied range. */
      overflow: 16,
    },
    /**
     * Quality gate per `ExportSettings.compression` level (pngquant `--quality min` analogue), see
     * src/compress/metrics.ts: PSNR on premultiplied RGBA of visible pixels; SSIM after a 2×2 downscale
     * (luma over black / white); banding = 99.9th percentile of the texture-masked jump of 8×8 block
     * mean errors between neighbouring blocks (8-bit levels). Calibrated on real Deck exports: undithered
     * 256-colour output (visible bands) scores 1.2–4.6, dithered 256-colour output 0.35–1.0. Below
     * ~38 dB the dither grain itself shows at 1:1 (streaks over light backgrounds).
     * `targetBanding`: feedback rounds run while banding is above it (pngquant `--quality max` analogue).
     * `smallerPalettes`: extra palette sizes tried for every image (stops at the first gate failure).
     */
    levels: {
      balanced: { minPsnr: 40, minSsim: 0.98, maxBanding: 1.1, targetBanding: 0.8, ditherStrength: 1, smallerPalettes: [] as readonly number[] },
      strong: { minPsnr: 38, minSsim: 0.97, maxBanding: 1.5, targetBanding: 1.5, ditherStrength: 1, smallerPalettes: [128, 64] as readonly number[] },
    },
    /** Images with at most this many distinct colours (flat graphics) also try the smaller palettes. */
    flatMaxColors: 4096,
    /** …as do images of at most this many pixels. */
    smallImagePixels: 65536,
    smallerPalettes: [128, 64, 32, 16, 8, 4, 2] as readonly number[],
    /**
     * zlib level / memLevel of palette IDAT. memLevel 7 (smaller Huffman blocks) beats 9 by ~1–2 % on
     * dithered indices; level 9 is ~4× slower than 7 for ~1.5 %, so images above `fastDeflatePixels`
     * use `fastDeflateLevel`.
     */
    deflateLevel: 9,
    deflateMemLevel: 7,
    fastDeflateLevel: 7,
    fastDeflatePixels: 2000000,
    /** zlib level of truecolour IDAT: pako's level 9 is up to 10× slower on filtered RGBA for < 1 % gain. */
    truecolorDeflateLevel: 6,
    /**
     * Several filter attempts / palette sizes are ranked at this fast zlib level (filters on at most
     * `rankSampleBytes` of scanlines, in bands spread over the image); only the winner is deflated at
     * the full level.
     */
    rankDeflateLevel: 2,
    rankSampleBytes: 4000000,
    /** Filter / zlib strategy combinations tried for palette and truecolour PNGs (smallest kept). */
    paletteAttempts: [{ filter: 'none', strategy: 'default' }] as ReadonlyArray<{ filter: 'none' | 'adaptive' | 'sub' | 'up' | 'paeth'; strategy: 'default' | 'filtered' }>,
    truecolorAttempts: [
      { filter: 'none', strategy: 'default' },
      { filter: 'sub', strategy: 'default' },
      { filter: 'adaptive', strategy: 'default' },
    ] as ReadonlyArray<{ filter: 'none' | 'adaptive' | 'sub' | 'up' | 'paeth'; strategy: 'default' | 'filtered' }>,
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

  /** Office limits (Open XML SDK data): sizes, blur radii and dash lengths are signed 32-bit integers. */
  ooxml: {
    maxInt32: 2147483647,
  },

  /** Product identity and metadata written to docProps / PDF info (never the PptxGenJS defaults). */
  meta: {
    /** User-visible product name (see PRODUCT_NAME above). */
    productName: PRODUCT_NAME,
    application: PRODUCT_NAME,
    defaultAuthor: PRODUCT_NAME,
    defaultCompany: '',
    /** Settings → About: support page (https://…) and e-mail. Each is shown only when non-empty. */
    supportUrl: '' as string,
    supportEmail: '' as string,
  },
} as const;

export type Config = typeof CONFIG;
