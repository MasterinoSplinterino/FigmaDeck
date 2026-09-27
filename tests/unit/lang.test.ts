import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { detectLang } from '../../src/shared/lang';

describe('detectLang', () => {
  it('Cyrillic → ru-RU', () => {
    expect(detectLang('Взрывной рост')).toBe('ru-RU');
    expect(detectLang('ёЁ')).toBe('ru-RU');
  });

  it('Latin → en-US (the default)', () => {
    expect(detectLang('Hello, world')).toBe('en-US');
    expect(CONFIG.text.defaultLang).toBe('en-US');
  });

  it('mixed Latin + Cyrillic → ru-RU (spell-checking Russian words matters more)', () => {
    expect(detectLang('Tech Awards · Москва')).toBe('ru-RU');
  });

  it('other scripts', () => {
    expect(detectLang('Καλημέρα')).toBe('el-GR');
    expect(detectLang('שלום')).toBe('he-IL');
    expect(detectLang('مرحبا')).toBe('ar-SA');
    expect(detectLang('こんにちは')).toBe('ja-JP');
    expect(detectLang('안녕하세요')).toBe('ko-KR');
    expect(detectLang('你好')).toBe('zh-CN');
  });

  it('text without script-specific letters uses the fallback', () => {
    expect(detectLang('2026')).toBe('en-US');
    expect(detectLang('', 'ru-RU')).toBe('ru-RU');
    expect(detectLang('— 42 —', 'de-DE')).toBe('de-DE');
  });
});
