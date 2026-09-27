/**
 * The only door from extract/ to Figma side effects. Everything else in extract/ reads node
 * properties and calls these functions, so tests can inject fakes (tests/helpers/figma-mocks.ts).
 *
 * Figma API notes (verified against @figma/plugin-typings 1.139):
 * - `exportAsync()` without `useAbsoluteBounds` renders the node's render bounds (shadows, outside
 *   strokes included) and returns `Uint8Array` for PNG / SVG / PDF. `SVG_STRING` would need no decoding
 *   but we keep bytes (no TextDecoder in the sandbox, and the UI wants bytes anyway).
 * - `clone()` parents the duplicate under `figma.currentPage` by default (typings); callers always
 *   move it to the original's page with `appendToPage` right away.
 * - `detachInstance()` returns a NEW FrameNode that replaces the instance.
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
  /** `node.clone()`; the caller moves the clone with `appendToPage`. */
  clone(node: SceneNode): SceneNode;
  appendToPage(page: PageNode, node: SceneNode): void;
  remove(node: SceneNode): void;
  detachInstance(node: InstanceNode): FrameNode;
  /** Give control back to Figma (keeps the editor responsive, lets "Cancel" messages in). */
  yieldToEventLoop(): Promise<void>;
}

/** The real environment (plugin main thread only). */
export function createFigmaEnv(): FigmaEnv {
  return {
    mixed: figma.mixed,
    exportAsync: (node, settings) => node.exportAsync(settings),
    getImageByHash: (hash) => figma.getImageByHash(hash),
    clone: (node) => (node as FrameNode).clone(),
    appendToPage: (page, node) => page.appendChild(node),
    remove: (node) => {
      if (!node.removed) node.remove();
    },
    detachInstance: (node) => node.detachInstance(),
    yieldToEventLoop: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}
