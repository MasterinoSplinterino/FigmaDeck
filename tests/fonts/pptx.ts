/**
 * Small PPTX packages for the font-embedding tests, made with pptxgenjs directly (not with src/build), so the
 * embedding prototype is tested against the plain pptxgenjs package layout too.
 */
import PptxGenJS from 'pptxgenjs';

export interface ProbeText {
  text: string;
  face: string;
  bold?: boolean;
  italic?: boolean;
}

/** One 13.333″ × 7.5″ slide with one text box per entry (48 pt, stacked). */
export async function makeTextPptx(lines: ProbeText[]): Promise<Uint8Array> {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = 'Font embedding probe';
  const slide = pres.addSlide();
  lines.forEach((l, i) => {
    slide.addText(l.text, {
      x: 0.5,
      y: 0.5 + i * 1.2,
      w: 12,
      h: 1,
      fontFace: l.face,
      fontSize: 48,
      bold: !!l.bold,
      italic: !!l.italic,
      color: '111111',
      margin: 0,
    });
  });
  const out = await pres.write({ outputType: 'uint8array' });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}
