/**
 * Minimal typings for the parts of `pngjs` used by the fixtures and the LibreOffice smoke test
 * (the package ships no types and @types/pngjs is not a dependency).
 */
declare module 'pngjs' {
  export interface PNGWriteOptions {
    /** 0 grayscale, 2 RGB, 4 grayscale + alpha, 6 RGBA. */
    colorType?: 0 | 2 | 4 | 6;
  }

  export class PNG {
    constructor(options?: { width?: number; height?: number });
    width: number;
    height: number;
    /** RGBA, 4 bytes per pixel, row-major. */
    data: Uint8Array;
    static sync: {
      read(buffer: Uint8Array): PNG;
      write(png: PNG, options?: PNGWriteOptions): Uint8Array;
    };
  }
}
