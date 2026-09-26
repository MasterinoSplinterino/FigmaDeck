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
  },

  ui: {
    windowWidth: 1000,
    windowHeight: 640,
    minWidth: 720,
    minHeight: 480,
    thumbnailWidth: 320,
    previewWidth: 1400,
  },

  export: {
    /** Yield to the event loop every N visited nodes (keeps Figma responsive, lets "Cancel" through). */
    yieldEveryNodes: 25,
    /** Max parallel exportAsync calls. */
    exportConcurrency: 4,
  },

  /** Metadata written to docProps (never the PptxGenJS defaults). */
  meta: {
    application: 'FigmaDeck',
    defaultAuthor: 'FigmaDeck',
    defaultCompany: '',
  },
} as const;

export type Config = typeof CONFIG;
