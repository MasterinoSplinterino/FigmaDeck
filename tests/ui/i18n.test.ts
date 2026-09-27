import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import type { RasterReason } from '../../src/ir/types';
import {
  DICTIONARIES,
  codeLabel,
  detectLang,
  formatBytes,
  formatDuration,
  getLang,
  pluralIndex,
  reasonLabel,
  resolveLang,
  setLang,
  t,
  toastText,
  tp,
  type Lang,
} from '../../src/ui/i18n';
import { RASTER_REASONS } from '../../src/ui/report';

const LANGS: Lang[] = ['en', 'ru'];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries', () => {
  const initial = getLang();
  afterEach(() => setLang(initial));

  it('en and ru have identical keys', () => {
    expect(Object.keys(DICTIONARIES.ru).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
  });

  it('no empty strings', () => {
    for (const lang of LANGS) for (const [key, value] of Object.entries(DICTIONARIES[lang])) expect(value.trim(), `${lang}:${key}`).not.toBe('');
  });

  it('placeholders match between languages (plural forms included)', () => {
    for (const key of Object.keys(DICTIONARIES.en) as Array<keyof typeof DICTIONARIES.en>) {
      const enForms = DICTIONARIES.en[key].split('|');
      const ruForms = DICTIONARIES.ru[key].split('|');
      const expected = placeholders(enForms[0]);
      for (const f of [...enForms, ...ruForms]) expect(placeholders(f), `${key}: "${f}"`).toEqual(expected);
    }
  });

  it('plural keys have 2 English and 3 Russian forms', () => {
    for (const key of Object.keys(DICTIONARIES.en) as Array<keyof typeof DICTIONARIES.en>) {
      const en = DICTIONARIES.en[key].split('|').length;
      const ru = DICTIONARIES.ru[key].split('|').length;
      if (en === 1) expect(ru, key).toBe(1);
      else {
        expect(en, key).toBe(2);
        expect(ru, key).toBe(3);
      }
    }
  });

  it('every RasterReason has a label in both languages', () => {
    const all: RasterReason[] = RASTER_REASONS;
    expect(all.length).toBeGreaterThanOrEqual(23);
    for (const lang of LANGS) {
      for (const r of all) {
        expect(`reason.${r}` in DICTIONARIES[lang], `${lang}:${r}`).toBe(true);
        expect(reasonLabel(r, lang)).not.toBe(r);
      }
    }
  });
});

describe('detectLang', () => {
  it('ru* → ru, everything else → en', () => {
    expect(detectLang('ru')).toBe('ru');
    expect(detectLang('ru-RU')).toBe('ru');
    expect(detectLang('RU-ua')).toBe('ru');
    expect(detectLang('en-US')).toBe('en');
    expect(detectLang('uk-UA')).toBe('en');
    expect(detectLang('run')).toBe('en');
    expect(detectLang('')).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });
});

describe('t / tp', () => {
  it('interpolates and leaves unknown placeholders alone', () => {
    expect(t('progress.extract', { i: 3, n: 10 }, 'en')).toBe('Processing slide 3 of 10');
    expect(t('progress.extract', { i: 3 }, 'en')).toBe('Processing slide 3 of {n}');
    expect(t('progress.extract', { i: 3, n: 10 }, 'ru')).toBe('Обработка слайда 3 из 10');
  });

  it('English plurals', () => {
    expect(tp('add.buttonN', 1, undefined, 'en')).toBe('Add 1 slide');
    expect(tp('add.buttonN', 2, undefined, 'en')).toBe('Add 2 slides');
    expect(tp('add.buttonN', 0, undefined, 'en')).toBe('Add 0 slides');
  });

  it('Russian plurals (one / few / many)', () => {
    expect(tp('add.buttonN', 1, undefined, 'ru')).toBe('Добавить 1 слайд');
    expect(tp('add.buttonN', 3, undefined, 'ru')).toBe('Добавить 3 слайда');
    expect(tp('add.buttonN', 5, undefined, 'ru')).toBe('Добавить 5 слайдов');
    expect(tp('add.buttonN', 11, undefined, 'ru')).toBe('Добавить 11 слайдов');
    expect(tp('add.buttonN', 21, undefined, 'ru')).toBe('Добавить 21 слайд');
    expect(tp('add.buttonN', 24, undefined, 'ru')).toBe('Добавить 24 слайда');
  });

  it('pluralIndex falls back to the last form for categories a language does not list', () => {
    expect(pluralIndex(1.5, 'ru')).toBe(2);
    expect(pluralIndex(1, 'en')).toBe(0);
    expect(pluralIndex(7, 'en')).toBe(1);
  });

  it('uses the current language by default', () => {
    setLang('ru');
    expect(t('common.cancel')).toBe('Отмена');
    setLang('en');
    expect(t('common.cancel')).toBe('Cancel');
  });
});

describe('formatting', () => {
  it('formatBytes', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(200 * 1024, 'en')).toBe('200 KB');
    expect(formatBytes(3.25 * 1024 * 1024, 'en')).toBe('3.3 MB');
    expect(formatBytes(1536, 'ru')).toBe('1,5 КБ');
  });

  it('formatDuration', () => {
    expect(formatDuration(3400, 'en')).toBe('3.4 s');
    expect(formatDuration(42_000, 'en')).toBe('42 s');
    expect(formatDuration(125_000, 'en')).toBe('2 min 5 s');
    expect(formatDuration(-5, 'en')).toBe('0 s');
  });

  it('codeLabel knows report codes and returns null otherwise', () => {
    expect(codeLabel('missing-font', 'en')).toMatch(/font/i);
    expect(codeLabel('missing-font', 'ru')).toMatch(/шрифт/i);
    expect(codeLabel('something-new', 'en')).toBeNull();
  });
});

describe('language setting', () => {
  it('auto → Russian only for a Russian system language; en / ru as chosen', () => {
    expect(resolveLang('auto', 'ru-RU')).toBe('ru');
    expect(resolveLang('auto', 'en-GB')).toBe('en');
    expect(resolveLang('auto', 'de-DE')).toBe('en');
    expect(resolveLang('auto', 'uk-UA')).toBe('en');
    expect(resolveLang('auto', '')).toBe('en');
    expect(resolveLang('en', 'ru-RU')).toBe('en');
    expect(resolveLang('ru', 'en-US')).toBe('ru');
    expect(resolveLang(undefined, 'ru')).toBe('ru');
  });

  it('language names are the same in both dictionaries (each in its own language)', () => {
    for (const key of ['settings.language.en', 'settings.language.ru'] as const) expect(DICTIONARIES.ru[key]).toBe(DICTIONARIES.en[key]);
  });
});

describe('toastText (main-thread toasts)', () => {
  it('localizes known codes, plural when params.n is a number; falls back to the English message', () => {
    expect(toastText({ message: 'x', code: 'no-frames-selected' }, 'ru')).toBe(DICTIONARIES.ru['toast.no-frames-selected']);
    expect(toastText({ message: 'x', code: 'slides-added', params: { n: 1 } }, 'en')).toBe('Added 1 slide to the deck');
    expect(toastText({ message: 'x', code: 'slides-added', params: { n: 3 } }, 'en')).toBe('Added 3 slides to the deck');
    expect(toastText({ message: 'x', code: 'slides-added', params: { n: 5 } }, 'ru')).toBe('В презентацию добавлено 5 слайдов');
    expect(toastText({ message: 'x', code: 'error', params: { message: 'Quota' } }, 'en')).toBe('Something went wrong: Quota');
    expect(toastText({ message: 'English fallback', code: 'unknown-code' }, 'ru')).toBe('English fallback');
    expect(toastText({ message: 'No code' }, 'ru')).toBe('No code');
  });

  it('every toast code main sends has a string', () => {
    for (const code of ['no-frames-selected', 'already-in-deck', 'slides-added', 'frame-missing', 'export-busy', 'fonts-failed', 'error']) {
      expect(`toast.${code}` in DICTIONARIES.en, code).toBe(true);
    }
  });
});

describe('copy', () => {
  it('{product} is the configured product name; no old or competitor names anywhere', () => {
    expect(t('report.textHeader', undefined, 'en')).toBe(`${CONFIG.meta.productName} export report`);
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(DICTIONARIES[lang])) {
        expect(value, `${lang}:${key}`).not.toMatch(/FigmaDeck|\bDeck\b|TinyPNG/);
      }
    }
  });

  it('English strings contain no Cyrillic except the Russian language name', () => {
    for (const [key, value] of Object.entries(DICTIONARIES.en)) {
      if (key === 'settings.language.ru') continue;
      expect(value, key).not.toMatch(/[\u0400-\u04ff]/);
    }
  });
});
