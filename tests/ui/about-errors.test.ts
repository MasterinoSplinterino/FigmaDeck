import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { APP_VERSION, noticesText, reflowLicense, supportLinks } from '../../src/ui/about';
import { cleanErrorMessage } from '../../src/ui/errors';

describe('cleanErrorMessage', () => {
  it('first line, without "Error:" prefixes or stack frames', () => {
    expect(cleanErrorMessage(new Error('Boom'))).toBe('Boom');
    expect(cleanErrorMessage(new TypeError('Cannot read properties of null'))).toBe('Cannot read properties of null');
    expect(cleanErrorMessage('Error: in exportAsync: Node is detached\n    at a (x.js:1:1)')).toBe('in exportAsync: Node is detached');
    expect(cleanErrorMessage('\n\n  at x (y.js:1:1)\nSecond line')).toBe('Second line');
    expect(cleanErrorMessage({ message: 'from an object' })).toBe('from an object');
  });

  it('nothing readable → empty (the caller shows a generic text)', () => {
    expect(cleanErrorMessage(undefined)).toBe('');
    expect(cleanErrorMessage(null)).toBe('');
    expect(cleanErrorMessage({})).toBe('');
    expect(cleanErrorMessage(new Error(''))).toBe('');
    expect(cleanErrorMessage('[object Object]')).toBe('');
  });

  it('bounded length with an ellipsis', () => {
    const text = cleanErrorMessage('y'.repeat(500), 40);
    expect(text).toHaveLength(40);
    expect(text.endsWith('…')).toBe(true);
    expect(cleanErrorMessage('z'.repeat(1000)).length).toBeLessThanOrEqual(CONFIG.ui.errorMessageMaxChars);
  });
});

describe('about', () => {
  it('version is "dev" outside the bundle (esbuild defines __APP_VERSION__)', () => {
    expect(APP_VERSION).toBe('dev');
  });

  it('support links: only the configured, valid ones', () => {
    expect(supportLinks({ supportUrl: '', supportEmail: '' })).toEqual({ url: null, email: null });
    expect(supportLinks({ supportUrl: ' https://example.com/help ', supportEmail: ' help@example.com ' })).toEqual({ url: 'https://example.com/help', email: 'help@example.com' });
    expect(supportLinks({ supportUrl: 'javascript:alert(1)', supportEmail: 'not an email' })).toEqual({ url: null, email: null });
    expect(supportLinks().email).toBe(CONFIG.meta.supportEmail || null);
  });

  it('notices text: one block per package with license, source and the full text', () => {
    const text = noticesText([
      { name: 'a', version: '1.0.0', license: 'MIT', url: 'https://github.com/x/a', text: 'MIT text A\n' },
      { name: 'b', version: '2.0.0', license: '0BSD', url: '', text: 'Text B' },
    ]);
    expect(text).toBe('a 1.0.0\nMIT · https://github.com/x/a\n\nMIT text A\n\n────────────────────────────────────────\n\nb 2.0.0\n0BSD\n\nText B');
  });
});

describe('reflowLicense', () => {
  it('joins hard-wrapped prose; keeps lists, headings and paragraph breaks', () => {
    const mit = 'Permission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files.\n\nTHE SOFTWARE IS PROVIDED "AS IS",\nWITHOUT WARRANTY.';
    expect(reflowLicense(mit)).toBe('Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY.');
    const zlib = '1. The origin of this software must not be misrepresented; you must not\n  claim that you wrote the original software.\n2. Altered source versions must be plainly marked.';
    expect(reflowLicense(zlib)).toBe(zlib);
    const heading = 'The MIT License\n===============';
    expect(reflowLicense(heading)).toBe(heading);
  });
});
