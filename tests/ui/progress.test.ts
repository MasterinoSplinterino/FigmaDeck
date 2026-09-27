import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { setLang } from '../../src/ui/i18n';
import { overallFraction, phaseGroups, phaseLabel, progressDetail, progressTitle, type ProgressState } from '../../src/ui/progress';

beforeAll(() => setLang('en'));

const p = (o: Partial<ProgressState>): ProgressState => ({ format: 'pptx', phase: 'extract', done: 0, total: 10, ...o });

describe('overallFraction', () => {
  it('starts at 0 and ends at 1 for every format', () => {
    for (const format of ['pptx', 'pptx-image', 'pdf', 'pdf-image', 'ir-json'] as const) {
      expect(overallFraction(p({ format, phase: 'starting' }))).toBe(0);
      const groups = phaseGroups(format);
      const last = groups[groups.length - 1];
      const phase = last === 'package' ? 'package' : last === 'merge' ? 'merge' : last;
      expect(overallFraction(p({ format, phase, done: 5, total: 5 }))).toBeCloseTo(1, 10);
    }
  });

  it('is monotonic through the PPTX pipeline', () => {
    const steps: ProgressState[] = [
      p({ phase: 'starting' }),
      p({ phase: 'extract', done: 0 }),
      p({ phase: 'extract', done: 5 }),
      p({ phase: 'extract', done: 10 }),
      p({ phase: 'images', done: 0, total: 4 }),
      p({ phase: 'images', done: 4, total: 4 }),
      p({ phase: 'build', done: 3 }),
      p({ phase: 'build', done: 10 }),
      p({ phase: 'package', done: 0, total: 1 }),
      p({ phase: 'package', done: 7, total: 10 }),
      p({ phase: 'package', done: 10, total: 10 }),
    ];
    const values = steps.map(overallFraction);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
  });

  it('weights come from CONFIG and are renormalized per format', () => {
    const w = CONFIG.ui.progressWeights;
    const sum = w.pdf + w.merge;
    expect(overallFraction(p({ format: 'pdf', phase: 'pdf', done: 10, total: 10 }))).toBeCloseTo(w.pdf / sum, 10);
  });

  it('clamps bad input and ignores phases foreign to the format', () => {
    expect(overallFraction(p({ phase: 'extract', done: 50, total: 10 }))).toBeLessThanOrEqual(1);
    expect(overallFraction(p({ phase: 'extract', done: 3, total: 0 }))).toBe(0);
    expect(overallFraction(p({ format: 'pdf', phase: 'images' }))).toBe(0);
  });
});

describe('labels', () => {
  it('shows the item in progress, 1-based and clamped', () => {
    expect(phaseLabel(p({ phase: 'extract', done: 0, total: 6 }))).toBe('Extracting slide 1 of 6');
    expect(phaseLabel(p({ phase: 'extract', done: 6, total: 6 }))).toBe('Extracting slide 6 of 6');
    expect(phaseLabel(p({ phase: 'images', done: 2, total: 9 }))).toBe('Optimizing images 3 of 9');
    expect(phaseLabel(p({ phase: 'pdf', done: 1, total: 3 }))).toBe('Exporting page 2 of 3');
    expect(phaseLabel(p({ phase: 'package' }))).toBe('Building PPTX');
    expect(phaseLabel(p({ phase: 'merge' }))).toBe('Merging PDF');
    expect(phaseLabel(p({ phase: 'starting' }))).toBe('Preparing…');
  });

  it('uses main\'s 1-based slide number while extracting', () => {
    expect(phaseLabel(p({ phase: 'extract', done: 0, total: 6, slide: 3 }))).toBe('Extracting slide 3 of 6');
  });

  it('localizes the detail line from the numeric fields, falls back to main\'s text', () => {
    expect(progressDetail(p({ detail: 'Agenda — 120 layers' }))).toBe('Agenda — 120 layers');
    expect(progressDetail(p({ detail: 'x', slideName: 'Agenda', layers: 1240 }))).toBe('Agenda — 1,240 layers');
    expect(progressDetail(p({ slideName: 'Agenda', layers: 1 }))).toBe('Agenda — 1 layer');
    expect(progressDetail(p({ slideName: 'Agenda', layers: 40, jobsDone: 3, jobsTotal: 12 }))).toBe('Agenda — rasterizing 3 of 12');
    expect(progressDetail(p({ layers: 40, jobsDone: 0, jobsTotal: 0 }))).toBe('40 layers');
    expect(progressDetail(p({}))).toBeUndefined();
    setLang('ru');
    try {
      expect(progressDetail(p({ slideName: 'Программа', layers: 3 }))).toBe('Программа — 3 слоя');
      expect(progressDetail(p({ slideName: 'Программа', layers: 5, jobsDone: 2, jobsTotal: 7 }))).toBe('Программа — растеризация 2 из 7');
    } finally {
      setLang('en');
    }
  });

  it('titles per format', () => {
    expect(progressTitle('pptx')).toBe('Exporting PowerPoint');
    expect(progressTitle('pdf-image')).toBe('Exporting PDF');
    expect(progressTitle('ir-json')).toBe('Exporting IR JSON');
  });
});
