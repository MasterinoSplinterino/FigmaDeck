/**
 * Figma separates consecutive list items by `listSpacing` (a styled-segment / paragraph field), every
 * other pair of paragraphs by `paragraphSpacing`.
 */
import { describe, expect, it } from 'vitest';
import { SEGMENT_FIELDS, readSegments, segmentsToParagraphs, textDefaults } from '../../src/extract/text';
import { MIXED, scene, text } from '../helpers/figma-mocks';

const paragraphsOf = (props: Parameters<typeof text>[0]) => {
  const n = scene<TextNode>(text(props));
  return segmentsToParagraphs(readSegments(n), textDefaults(n, MIXED));
};

const item = (characters: string, extra: Record<string, unknown> = {}) => ({ characters, listOptions: { type: 'UNORDERED' as const }, indentation: 1, ...extra });

describe('list spacing', () => {
  it('list item → list item: listSpacing; list item → plain paragraph and plain → plain: paragraphSpacing', () => {
    const ps = paragraphsOf({
      paragraphSpacing: 12,
      segments: [
        { characters: 'Intro\n', listOptions: { type: 'NONE' } },
        item('One\n', { listSpacing: 6 }),
        item('Two\n', { listSpacing: 6, indentation: 2 }),
        item('Three\n', { listSpacing: 6 }),
        { characters: 'After\n', listOptions: { type: 'NONE' } },
        { characters: 'End', listOptions: { type: 'NONE' } },
      ],
    });
    expect(ps.map((p) => [p.runs[0]?.text, p.list?.level ?? null, p.spaceAfter])).toEqual([
      ['Intro', null, 12],
      ['One', 0, 6],
      ['Two', 1, 6], // nested levels are list items too
      ['Three', 0, 12], // followed by a plain paragraph
      ['After', null, 12],
      ['End', null, 12],
    ]);
  });

  it('the list spacing of the item itself decides; node-level value as fallback', () => {
    const ps = paragraphsOf({
      paragraphSpacing: 10,
      listSpacing: 4,
      segments: [item('A\n', { listSpacing: 8 }), item('B\n', { listSpacing: undefined }), item('C')],
    });
    // Segment without the field → node-level listSpacing (4).
    expect(ps.map((p) => p.spaceAfter)).toEqual([8, 4, 10]);
  });

  it('zero list spacing is honored (Figma default), not replaced by the paragraph spacing', () => {
    const ps = paragraphsOf({ paragraphSpacing: 16, segments: [item('A\n'), item('B')] });
    expect(ps.map((p) => p.spaceAfter)).toEqual([0, 16]);
  });

  it('requests listSpacing from getStyledTextSegments', () => {
    expect(SEGMENT_FIELDS).toContain('listSpacing');
    const n = text({ characters: 'x' });
    const requested: string[][] = [];
    const original = n.getStyledTextSegments as (fields: string[]) => unknown;
    n.getStyledTextSegments = (fields: string[]) => {
      requested.push([...fields]);
      return original(fields);
    };
    readSegments(scene<TextNode>(n));
    expect(requested[0]).toContain('listSpacing');
  });

  it('older clients without listSpacing: other paragraph fields are still read, list items keep paragraphSpacing', () => {
    const ps = paragraphsOf({
      rejectFields: ['listSpacing'],
      listSpacing: undefined,
      paragraphSpacing: 12,
      segments: [item('A\n', { paragraphSpacing: 20 }), item('B')],
    });
    expect(ps.map((p) => p.spaceAfter)).toEqual([20, 12]);
  });
});
