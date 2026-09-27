/**
 * The only door from extract/ to Figma side effects. Everything else in extract/ reads node
 * properties and calls these functions, so tests can inject fakes (tests/helpers/figma-mocks.ts).
 *
 * Figma API notes (verified in real Figma, see docs/figma-api-notes.md):
 * - `exportAsync()` without `useAbsoluteBounds` renders the node's `absoluteRenderBounds` — already
 *   clipped by ancestors with `clipsContent` — into a `ceil(w·s) × ceil(h·s)` PNG; a visible node that is
 *   clipped away entirely has `absoluteRenderBounds === null` and exports as a 1×1 PNG. Own opacity is
 *   baked into the bitmap, ancestors' opacity is not. Bytes are returned for PNG / SVG / PDF (no
 *   TextDecoder in the sandbox, and the UI wants bytes anyway).
 * - `clone()` of a NESTED node puts the clone on `figma.currentPage` (not into the original parent);
 *   `clone` below guarantees that the clone sits at the root of the current page.
 * - `detachInstance()` returns a NEW FrameNode with a new id; the instance id is gone afterwards.
 * - A removed COMPONENT stays resolvable by id with `parent === null`: check `removed` / `parent`.
 * - `figma.mixed` is a unique symbol returned by properties with mixed values.
 */

export interface ImageHandle {
  getBytesAsync(): Promise<Uint8Array>;
  /** px */
  getSizeAsync(): Promise<{ width: number; height: number }>;
}

export type ExportRequest = ExportSettingsImage | ExportSettingsSVG | ExportSettingsPDF;

export interface FigmaEnv {
  /** `figma.mixed` */
  readonly mixed: symbol;
  exportAsync(node: SceneNode, settings: ExportRequest): Promise<Uint8Array>;
  getImageByHash(hash: string): ImageHandle | null;
  /**
   * `node.clone()`, placed at the ROOT of the current page (where Figma puts clones of nested nodes).
   * The caller sets `relativeTransform = original.absoluteTransform`; the clone's page may differ from
   * the original's page, so placement math must map the clone's bounds back through the original's
   * transform (raster.ts), never compare coordinates across pages.
   */
  clone(node: SceneNode): SceneNode;
  remove(node: SceneNode): void;
  /** Returns the NEW node that replaces the instance (new id). */
  detachInstance(node: InstanceNode): FrameNode;
  /** `figma.loadFontAsync` (rejects for fonts that are not available). */
  loadFontAsync(font: FontName): Promise<void>;
  /** `figma.createText()` (a new empty TEXT node on the current page). */
  createText(): TextNode;
  /** Give control back to Figma (keeps the editor responsive, lets "Cancel" messages in). */
  yieldToEventLoop(): Promise<void>;
}

/** The node is still part of the document (not removed, still parented). */
export function isAlive(node: BaseNode): boolean {
  return !node.removed && node.parent !== null;
}

/** The real environment (plugin main thread only). */
export function createFigmaEnv(): FigmaEnv {
  return {
    mixed: figma.mixed,
    exportAsync: (node, settings) => node.exportAsync(settings),
    getImageByHash: (hash) => figma.getImageByHash(hash),
    clone: (node) => {
      const copy = (node as FrameNode).clone();
      // Clones of nested nodes already land on the current page; make sure of it for any other case
      // (a clone left inside an auto-layout parent would reflow it).
      if (!copy.parent || copy.parent.type !== 'PAGE') figma.currentPage.appendChild(copy);
      return copy;
    },
    remove: (node) => {
      if (!node.removed) node.remove();
    },
    detachInstance: (node) => node.detachInstance(),
    loadFontAsync: (font) => figma.loadFontAsync(font),
    createText: () => figma.createText(),
    yieldToEventLoop: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}
